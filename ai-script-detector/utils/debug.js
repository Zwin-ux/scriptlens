(function (root) {
  const ScriptLensDebug = (root.ScriptLensDebug = root.ScriptLensDebug || {});
  const HISTORY_LIMIT = 250;
  const history = Array.isArray(ScriptLensDebug.history)
    ? ScriptLensDebug.history
    : [];

  ScriptLensDebug.history = history;
  ScriptLensDebug.createLogger = createLogger;
  ScriptLensDebug.installGlobalErrorHandlers = installGlobalErrorHandlers;
  ScriptLensDebug.getHistory = getHistory;
  ScriptLensDebug.sanitize = sanitize;
  ScriptLensDebug.createTraceId = createTraceId;

  function createLogger(scope) {
    const scopeLabel = String(scope || "app");
    return {
      log(message, details) {
        emit("log", scopeLabel, message, details);
      },
      info(message, details) {
        emit("info", scopeLabel, message, details);
      },
      warn(message, details) {
        emit("warn", scopeLabel, message, details);
      },
      error(message, details) {
        emit("error", scopeLabel, message, details);
      },
      child(childScope) {
        return createLogger(`${scopeLabel}:${String(childScope || "child")}`);
      }
    };
  }

  function installGlobalErrorHandlers(scope) {
    if (typeof root.addEventListener !== "function") {
      return;
    }

    const key = `__scriptLensDebugHandlersInstalled:${String(scope || "app")}`;
    if (root[key]) {
      return;
    }
    root[key] = true;

    const logger = createLogger(scope || "global");
    root.addEventListener(
      "error",
      (event) => {
        logger.error("Unhandled error", {
          message: event?.message || "",
          filename: event?.filename || "",
          line: event?.lineno || null,
          column: event?.colno || null,
          stack: event?.error?.stack || ""
        });
      },
      true
    );
    root.addEventListener("unhandledrejection", (event) => {
      logger.error("Unhandled rejection", {
        reason: sanitize(event?.reason)
      });
    });
  }

  function getHistory() {
    return history.slice();
  }

  function createTraceId(prefix) {
    return `${String(prefix || "trace")}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2, 8)}`;
  }

  function emit(level, scope, message, details) {
    const entry = {
      at: new Date().toISOString(),
      level,
      scope,
      message: String(message || ""),
      details: details === undefined ? undefined : sanitize(details)
    };

    history.push(entry);
    if (history.length > HISTORY_LIMIT) {
      history.splice(0, history.length - HISTORY_LIMIT);
    }

    const consoleMethod =
      typeof console !== "undefined" && typeof console[level] === "function"
        ? console[level]
        : console.log;

    if (entry.details === undefined) {
      consoleMethod(`[ScriptLens][${scope}] ${entry.message}`);
      return;
    }

    consoleMethod(`[ScriptLens][${scope}] ${entry.message}`, entry.details);
  }

  function sanitize(value, depth) {
    const level = Number(depth) || 0;
    if (value == null || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      return value.length > 500 ? `${value.slice(0, 497)}...` : value;
    }
    if (value instanceof Error) {
      return {
        name: value.name || "Error",
        message: value.message || "",
        stack: value.stack || ""
      };
    }
    if (level >= 3) {
      return typeof value;
    }
    if (Array.isArray(value)) {
      return value.slice(0, 12).map((entry) => sanitize(entry, level + 1));
    }
    if (typeof value === "object") {
      const output = {};
      Object.keys(value)
        .slice(0, 20)
        .forEach((key) => {
          output[key] = sanitize(value[key], level + 1);
        });
      return output;
    }
    return String(value);
  }
})(globalThis);
