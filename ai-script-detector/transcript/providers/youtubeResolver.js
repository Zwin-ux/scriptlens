(function (root) {
  const ScriptLens = (root.ScriptLens = root.ScriptLens || {});
  const Transcript = (ScriptLens.transcript = ScriptLens.transcript || {});
  const Providers = (Transcript.providers = Transcript.providers || {});
  const Debug = root.ScriptLensDebug || {};
  const logger = Debug.createLogger
    ? Debug.createLogger("youtube-resolver")
    : console;

  const TOTAL_TIMEOUT_MS = 6000;
  const BOOTSTRAP_SETTLE_WINDOW_MS = 1200;
  const PHASE_ONE_WINDOW_MS = 2200;
  const SETTLEMENT_WINDOW_MS = 400;
  const STRATEGY_TIMEOUTS = {
    "youtubei-transcript": 2200,
    "caption-track": 2200,
    "dom-transcript": 7000
  };

  Providers.youtubeResolver = {
    resolve
  };

  async function resolve(context) {
    const startedAt = Date.now();
    const deadlineAt = startedAt + (Number(context?.localTimeoutMs) || TOTAL_TIMEOUT_MS);
    const strategies = Transcript.strategies || {};
    const attempts = [];
    const errors = [];
    const candidates = [];
    const resolvedContext = await settleAdapterState(context, startedAt + BOOTSTRAP_SETTLE_WINDOW_MS);
    logger.info("resolve:start", {
      traceId: context?.traceId || "",
      videoId: resolvedContext?.adapter?.videoId || "",
      transcriptParams: Boolean(resolvedContext?.adapter?.bootstrapSnapshot?.transcriptParams),
      captionTracks: Array.isArray(resolvedContext?.adapter?.bootstrapSnapshot?.captionTracks)
        ? resolvedContext.adapter.bootstrapSnapshot.captionTracks.length
        : 0,
      domTranscriptSegments: Array.isArray(resolvedContext?.adapter?.domTranscriptSegments)
        ? resolvedContext.adapter.domTranscriptSegments.length
        : 0
    });

    const phaseOneTasks = [
      startStrategyTask(
        "caption-track",
        strategies.captionTrack?.run,
        resolvedContext,
        deadlineAt,
        STRATEGY_TIMEOUTS["caption-track"]
      ),
      startStrategyTask(
        "youtubei-transcript",
        strategies.youtubei?.run,
        resolvedContext,
        deadlineAt,
        STRATEGY_TIMEOUTS["youtubei-transcript"]
      )
    ];

    await waitForPhaseOne(phaseOneTasks, startedAt + PHASE_ONE_WINDOW_MS);
    collectSettledResults(phaseOneTasks, attempts, errors, candidates);
    logger.info("resolve:afterPhaseOne", {
      traceId: context?.traceId || "",
      attempts: attempts.map(summarizeAttempt),
      errors: errors.map(summarizeError),
      candidates: candidates.map(summarizeCandidate)
    });

    if (!hasStrongTranscriptCandidate(candidates)) {
      const result = await runStrategyWithTimeout(
        "dom-transcript",
        strategies.domTranscript?.run,
        resolvedContext,
        deadlineAt,
        STRATEGY_TIMEOUTS["dom-transcript"]
      );
      attempts.push(result.attempt);
      if (result.error) {
        errors.push(result.error);
      }
      if (result.candidate) {
        candidates.push(result.candidate);
      }
      logger.info("resolve:domTranscript", {
        traceId: context?.traceId || "",
        attempt: summarizeAttempt(result.attempt),
        error: summarizeError(result.error),
        candidate: summarizeCandidate(result.candidate)
      });
    }

    const selection = chooseWinner(candidates);
    const resolverPath = attempts
      .filter((attempt) => !attempt.skipped)
      .map((attempt) => `${attempt.provider}:${attempt.strategy}`);

    if (!selection.winner) {
      logger.warn("resolve:noWinner", {
        traceId: context?.traceId || "",
        attempts: attempts.map(summarizeAttempt),
        errors: errors.map(summarizeError)
      });
      return Transcript.normalize.buildUnavailableResult({
        requestedLanguageCode: context?.requestedLanguageCode || null,
        videoDurationSeconds: resolvedContext?.adapter?.videoDurationSeconds || null,
        provider: "youtubeResolver",
        providerClass: "local",
        strategy: "transcript-unavailable",
        sourceLabel: "Transcript unavailable",
        warnings: ["resolver_exhausted"],
        errors,
        resolverAttempts: attempts,
        resolverPath,
        winnerSelectedBy: ["no-usable-candidate"]
      });
    }

    const winner = {
      ...selection.winner,
      errors,
      resolverAttempts: attempts,
      resolverPath,
      winnerSelectedBy: selection.reasons
    };

    logger.info("resolve:winner", {
      traceId: context?.traceId || "",
      winner: summarizeCandidate(winner),
      reasons: selection.reasons
    });

    return winner;
  }

  async function waitForPhaseOne(tasks, phaseOneDeadlineAt) {
    let firstUsableAt = null;

    while (Date.now() < phaseOneDeadlineAt) {
      const settledCandidates = tasks
        .map((task) => task.result?.candidate)
        .filter((candidate) => candidate && candidate.__usableTranscript);

      if (!firstUsableAt && settledCandidates.length) {
        firstUsableAt = Date.now();
      }

      if (tasks.every((task) => task.settled)) {
        return;
      }

      if (firstUsableAt && Date.now() >= firstUsableAt + SETTLEMENT_WINDOW_MS) {
        return;
      }

      await delay(40);
    }
  }

  function collectSettledResults(tasks, attempts, errors, candidates) {
    tasks.forEach((task) => {
      if (!task.settled || !task.result) {
        return;
      }
      attempts.push(task.result.attempt);
      if (task.result.error) {
        errors.push(task.result.error);
      }
      if (task.result.candidate) {
        candidates.push(task.result.candidate);
      }
    });
  }

  function startStrategyTask(strategy, handler, context, deadlineAt, timeoutMs) {
    const task = {
      strategy,
      settled: false,
      result: null
    };

    runStrategyWithTimeout(strategy, handler, context, deadlineAt, timeoutMs)
      .then((result) => {
        logger.info("strategyTask:settled", {
          traceId: context?.traceId || "",
          strategy,
          attempt: summarizeAttempt(result.attempt),
          error: summarizeError(result.error),
          candidate: summarizeCandidate(result.candidate)
        });
        task.settled = true;
        task.result = result;
      })
      .catch((error) => {
        logger.error("strategyTask:crashed", {
          traceId: context?.traceId || "",
          strategy,
          error: {
            message: error?.message || "",
            stack: error?.stack || ""
          }
        });
        task.settled = true;
        task.result = {
          attempt: buildAttempt(strategy, false, false, 0, null, [], "unexpected_error"),
          candidate: null,
          error: buildError(strategy, "unexpected_error", error?.message || "Unexpected resolver error.")
        };
      });

    return task;
  }

  async function runStrategyWithTimeout(strategy, handler, context, deadlineAt, timeoutMs) {
    const startedAt = Date.now();
    const remainingMs = Math.max(0, deadlineAt - startedAt);
    const effectiveTimeout = Math.min(timeoutMs, remainingMs);
    const abortController = new AbortController();
    const cleanupParentAbort = linkParentAbort(context?.signal, abortController);

    if (!handler || effectiveTimeout <= 0) {
      cleanupParentAbort();
      return {
        attempt: buildAttempt(strategy, false, true, 0, null, [], "timeout"),
        candidate: null,
        error: buildError(strategy, "timeout", "Resolver time budget was exhausted.")
      };
    }

    try {
      const rawResult = await promiseWithTimeout(
        handler({
          ...context,
          signal: abortController.signal
        }),
        effectiveTimeout,
        () => abortController.abort()
      );
      const durationMs = Date.now() - startedAt;
      cleanupParentAbort();

      if (!rawResult?.ok) {
        return {
          attempt: buildAttempt(
            strategy,
            false,
            false,
            durationMs,
            null,
            rawResult?.warningCodes || [],
            rawResult?.errorCode || "strategy_failed"
          ),
          candidate: null,
          error: buildError(
            strategy,
            rawResult?.errorCode || "strategy_failed",
            rawResult?.errorMessage || "The strategy did not return usable text."
          )
        };
      }

      const candidate = Transcript.normalize.normalizeCandidate(rawResult, {
        maxTextLength: context?.maxTextLength || 18000,
        requestedLanguageCode: context?.requestedLanguageCode || null
      });

      if (!candidate.ok) {
        return {
          attempt: buildAttempt(
            strategy,
            false,
            false,
            durationMs,
            candidate.sourceConfidence || null,
            candidate.warnings || [],
            "empty_candidate"
          ),
          candidate: null,
          error: buildError(strategy, "empty_candidate", "The candidate contained no usable text.")
        };
      }

      return {
        attempt: buildAttempt(
          strategy,
          true,
          false,
          durationMs,
          candidate.sourceConfidence || null,
          candidate.warnings || [],
          null
        ),
        candidate,
        error: null
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      cleanupParentAbort();
      const message = String(error?.message || "");
      const navigationChanged = Boolean(context?.signal?.aborted);
      const timeoutError = /timeout/i.test(message);
      const code = navigationChanged
        ? "navigation_changed"
        : timeoutError
          ? "timeout"
          : "strategy_failed";
      return {
        attempt: buildAttempt(strategy, false, false, durationMs, null, [], code),
        candidate: null,
        error: buildError(
          strategy,
          code,
          navigationChanged
            ? "The active YouTube video changed while the resolver was running."
            : error?.message || "The strategy request failed."
        )
      };
    }
  }

  function chooseWinner(candidates) {
    if (!candidates.length) {
      return {
        winner: null,
        reasons: ["no-usable-candidate"]
      };
    }

    let winner = candidates[0];
    let reasons = ["single-candidate"];

    for (let index = 1; index < candidates.length; index += 1) {
      const comparison = Transcript.normalize.compareCandidates(winner, candidates[index]);
      winner = comparison.winner;
      reasons = comparison.reasons;
    }

    return {
      winner,
      reasons
    };
  }

  async function settleAdapterState(context, settleDeadlineAt) {
    let workingContext = {
      ...(context || {})
    };

    if (!workingContext.refreshAdapter || hasTranscriptSignals(workingContext.adapter)) {
      return workingContext;
    }

    while (Date.now() < settleDeadlineAt) {
      const refreshedAdapter = await workingContext
        .refreshAdapter({ reason: "bootstrap-settle" })
        .catch(() => null);

      if (refreshedAdapter) {
        workingContext = {
          ...workingContext,
          adapter: refreshedAdapter
        };
      }

      if (hasTranscriptSignals(workingContext.adapter)) {
        return workingContext;
      }

      await delay(180);
    }

    return workingContext;
  }

  function hasTranscriptSignals(adapter) {
    const bootstrap = adapter?.bootstrapSnapshot || {};
    const tracks = Array.isArray(bootstrap.captionTracks) ? bootstrap.captionTracks : [];
    const domSegments = Array.isArray(adapter?.domTranscriptSegments)
      ? adapter.domTranscriptSegments
      : [];

    return Boolean(
      tracks.length ||
        bootstrap.transcriptParams ||
        domSegments.length ||
        bootstrap.observedTranscriptRequest?.params
    );
  }

  function hasStrongTranscriptCandidate(candidates) {
    return candidates.some((candidate) => candidate?.quality === "strong-transcript");
  }

  function summarizeAttempt(attempt) {
    if (!attempt) {
      return null;
    }

    return {
      strategy: attempt.strategy || "",
      ok: Boolean(attempt.ok),
      skipped: Boolean(attempt.skipped),
      durationMs: attempt.durationMs || 0,
      sourceConfidence: attempt.sourceConfidence || null,
      warningCodes: Array.isArray(attempt.warningCodes)
        ? attempt.warningCodes.slice(0, 6)
        : [],
      errorCode: attempt.errorCode || null
    };
  }

  function summarizeError(error) {
    if (!error) {
      return null;
    }

    return {
      strategy: error.strategy || "",
      code: error.code || "",
      message: error.message || ""
    };
  }

  function summarizeCandidate(candidate) {
    if (!candidate) {
      return null;
    }

    return {
      provider: candidate.provider || null,
      strategy: candidate.strategy || null,
      quality: candidate.quality || null,
      sourceConfidence: candidate.sourceConfidence || null,
      warnings: Array.isArray(candidate.warnings) ? candidate.warnings.slice(0, 6) : [],
      segmentCount: candidate.segmentCount || 0,
      coverageRatio:
        typeof candidate.coverageRatio === "number" ? candidate.coverageRatio : null,
      textLength: String(candidate.text || "").length
    };
  }

  function buildAttempt(strategy, ok, skipped, durationMs, sourceConfidence, warningCodes, errorCode) {
    return {
      provider: "youtubeResolver",
      strategy,
      ok: Boolean(ok),
      skipped: Boolean(skipped),
      durationMs: Math.max(0, Math.round(durationMs || 0)),
      sourceConfidence: sourceConfidence || null,
      warningCodes: Array.isArray(warningCodes) ? warningCodes.slice() : [],
      errorCode: errorCode || null
    };
  }

  function buildError(strategy, code, message) {
    return {
      provider: "youtubeResolver",
      strategy,
      code,
      message
    };
  }

  function promiseWithTimeout(promise, timeoutMs, onTimeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (typeof onTimeout === "function") {
          onTimeout();
        }
        reject(new Error("timeout"));
      }, timeoutMs);

      Promise.resolve(promise)
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  function dedupeList(values) {
    const seen = new Set();
    return values.filter((value) => {
      const key = String(value || "");
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function delay(timeoutMs) {
    return new Promise((resolve) => setTimeout(resolve, timeoutMs));
  }

  function linkParentAbort(parentSignal, abortController) {
    if (!parentSignal) {
      return () => {};
    }

    const handleAbort = () => {
      abortController.abort(parentSignal.reason);
    };

    if (parentSignal.aborted) {
      handleAbort();
      return () => {};
    }

    parentSignal.addEventListener("abort", handleAbort, { once: true });
    return () => {
      parentSignal.removeEventListener("abort", handleAbort);
    };
  }
})(globalThis);
