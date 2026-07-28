const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  downloadObservedBrowserSessionMedia,
  resolveTranscriptRequest,
  selectBrowserSessionMediaCandidate
} = require("../backend/resolve");

test.describe("ScriptLens backend transcript resolver", () => {
  test("returns a normalized caption-track transcript contract", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "360"
        },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                baseUrl: "https://captions.example/manual",
                languageCode: "en",
                kind: "",
                name: { simpleText: "English" }
              }
            ]
          }
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      if (String(url).startsWith("https://captions.example/manual")) {
        return makeTextResponse(
          JSON.stringify({
            events: Array.from({ length: 20 }, (_, index) => ({
              tStartMs: index * 18000,
              dDurationMs: 17000,
              segs: [
                {
                  utf8: `Caption segment ${index + 1} carries enough spoken detail to behave like a usable transcript sample.`
                }
              ]
            }))
          })
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=abc123xyz78",
        requestedLanguageCode: "en",
        includeTimestamps: true
      },
      { fetchImpl }
    );

    expect(result.ok).toBeTruthy();
    expect(result.providerClass).toBe("backend");
    expect(result.sourceLabel).toContain("caption");
    expect(result.sourceConfidence).toBe("high");
    expect(result.quality).toBe("strong-transcript");
    expect(result.transcriptSpanSeconds).toBeGreaterThan(120);
    expect(result.videoDurationSeconds).toBe(360);
    expect(result.coverageRatio).toBeGreaterThan(0.45);
    expect(result.recoveryTier).toBe("hosted_transcript");
    expect(result.originKind).toBe("manual_caption_track");
    expect(result.sourceTrustTier).toBe("caption-derived");
    expect(result.winnerReason).toMatch(/^quality-eligible:/);
    expect(result.qualityGate?.eligible).toBeTruthy();
    expect(result.warnings).toContain("backend_static_caption_track");
    expect(Array.isArray(result.segments)).toBeTruthy();
    expect(result.segments.length).toBeGreaterThanOrEqual(18);
    expect(typeof result.text).toBe("string");
  });

  test("falls back to a headless transcript result when static extraction misses", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "240"
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=def456uvw90",
        requestedLanguageCode: "en"
      },
      {
        fetchImpl,
        headlessResolver: async () => ({
          ok: true,
          text: Array.from({ length: 12 }, (_, index) => {
            return `Headless segment ${index + 1} adds enough detail to form a reliable backend transcript fallback.`;
          }).join("\n"),
          segments: Array.from({ length: 12 }, (_, index) => ({
            startMs: index * 15000,
            durationMs: 12000,
            text: `Headless segment ${index + 1} adds enough detail to form a reliable backend transcript fallback.`
          })),
          languageCode: "en",
          originalLanguageCode: "en",
          sourceConfidence: "medium",
          videoDurationSeconds: 240,
          warnings: ["backend_headless_test"]
        })
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.providerClass).toBe("backend");
    expect(result.sourceLabel).toBe("Headless transcript panel");
    expect(result.sourceConfidence).toBe("medium");
    expect(result.quality).toBe("partial-transcript");
    expect(result.transcriptSpanSeconds).toBeGreaterThan(100);
    expect(result.videoDurationSeconds).toBe(240);
    expect(result.warnings).toContain("backend_headless_fallback");
    expect(result.warnings).toContain("backend_headless_test");
  });

  test("uses yt-dlp fallback when static and youtubei paths miss", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "879"
        },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                baseUrl: "https://captions.example/blocked",
                languageCode: "en",
                kind: "asr",
                name: { simpleText: "English" }
              }
            ]
          }
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      if (String(url).startsWith("https://captions.example/blocked")) {
        return makeTextResponse("");
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=RtuXNUlUX7Q",
        requestedLanguageCode: "en",
        includeTimestamps: true
      },
      {
        fetchImpl,
        ytDlpResolver: async () => ({
          ok: true,
          text: Array.from({ length: 16 }, (_, index) => {
            return `yt-dlp segment ${index + 1} carries enough spoken detail to satisfy transcript-first analysis on a blocked YouTube caption path.`;
          }).join("\n"),
          segments: Array.from({ length: 16 }, (_, index) => ({
            startMs: index * 55000,
            durationMs: 50000,
            text: `yt-dlp segment ${index + 1} carries enough spoken detail to satisfy transcript-first analysis on a blocked YouTube caption path.`
          })),
          sourceConfidence: "high",
          languageCode: "en",
          originalLanguageCode: "en",
          warnings: ["backend_yt_dlp_test"]
        }),
        headlessResolver: async () => ({
          ok: false,
          errorCode: "backend_headless_failed",
          errorMessage: "Should not be needed after yt-dlp success."
        })
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.providerClass).toBe("backend");
    expect(result.sourceLabel).toBe("Backend yt-dlp transcript");
    expect(result.sourceConfidence).toBe("high");
    expect(result.quality).toBe("partial-transcript");
    expect(result.coverageRatio).toBeGreaterThan(0.45);
    expect(result.transcriptSpanSeconds).toBeGreaterThan(120);
    expect(result.videoDurationSeconds).toBe(879);
    expect(result.warnings).toContain("backend_yt_dlp_fallback");
    expect(result.warnings).toContain("backend_yt_dlp_test");
  });

  test("falls back from json3 to vtt and reports yt-dlp attempt diagnostics", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "420"
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const ytDlpScript = [
      "const fs=require('fs');",
      "const args=process.argv.slice(1);",
      "const outIndex=args.indexOf('-o');",
      "const outputTemplate=args[outIndex+1];",
      "const formatIndex=args.indexOf('--sub-format');",
      "const format=formatIndex>=0?args[formatIndex+1]:'best';",
      "if(format==='json3'){process.exit(0);}",
      "const outputPath=outputTemplate.replace('%(id)s','scriptlensvideo').replace('%(ext)s','en.vtt');",
      "const cues=['WEBVTT'];",
      "for(let i=0;i<24;i+=1){const start=i*4; const end=start+4; const stamp=(value)=>`00:00:${String(value).padStart(2,'0')}.000`; cues.push('', `${stamp(start)} --> ${stamp(end)}`, `VTT subtitle segment ${i+1} carries unique detail for transcript scoring and backend recovery coverage.`);}",
      "fs.writeFileSync(outputPath,cues.join('\\n'));"
    ].join("");

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=vtt123fallback",
        requestedLanguageCode: "en",
        includeTimestamps: true,
        allowAutomaticAsr: false
      },
      {
        fetchImpl,
        ytDlpCommand: [process.execPath, "-e", ytDlpScript, "--"],
        headlessResolver: async () => ({
          ok: false,
          errorCode: "backend_headless_failed",
          errorMessage: "Should not run after yt-dlp fallback."
        })
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.originKind).toBe("manual_caption_track");
    const ytDlpStage = result.stageTelemetry.find((entry) => entry.stage === "yt-dlp-captions");
    expect(ytDlpStage?.detail?.attempts?.length).toBeGreaterThanOrEqual(2);
    expect(ytDlpStage?.detail?.selectedFormat).toBe("vtt");
    expect(ytDlpStage?.detail?.chosenSubtitleFile).toContain(".vtt");
    expect(ytDlpStage?.detail?.attempts?.[0]?.formatPreference).toBe("json3");
    expect(ytDlpStage?.detail?.attempts?.[1]?.formatPreference).toBe("vtt");
  });

  test("passes ignore-no-formats-error so yt-dlp can still write subtitles", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "420"
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const ytDlpScript = [
      "const fs=require('fs');",
      "const args=process.argv.slice(1);",
      "if(!args.includes('--ignore-no-formats-error')){process.stderr.write('missing ignore flag');process.exit(8);}",
      "const outIndex=args.indexOf('-o');",
      "const outputTemplate=args[outIndex+1];",
      "const outputPath=outputTemplate.replace('%(id)s','scriptlensvideo').replace('%(ext)s','en.json3');",
      "const payload={events:Array.from({length:18},(_,index)=>({tStartMs:index*5000,dDurationMs:4000,segs:[{utf8:`No-formats subtitle segment ${index+1} still produces a valid transcript path.`}]}))};",
      "fs.writeFileSync(outputPath,JSON.stringify(payload));"
    ].join("");

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=nofmtsub0001",
        requestedLanguageCode: "en",
        allowAutomaticAsr: false
      },
      {
        fetchImpl,
        ytDlpCommand: [process.execPath, "-e", ytDlpScript, "--"],
        headlessResolver: async () => ({
          ok: false,
          errorCode: "backend_headless_failed",
          errorMessage: "Should not run after yt-dlp success."
        })
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.originKind).toBe("manual_caption_track");
    const ytDlpStage = result.stageTelemetry.find((entry) => entry.stage === "yt-dlp-captions");
    expect(ytDlpStage?.detail?.attempts?.[0]?.args).toContain("--ignore-no-formats-error");
  });

  test("accepts short high-coverage transcripts when the video duration is short", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "19"
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=shortclip001",
        requestedLanguageCode: "en",
        allowAutomaticAsr: false
      },
      {
        fetchImpl,
        ytDlpResolver: async () => ({
          ok: true,
          text: [
            "This short clip still includes a full sentence with enough transcript detail to analyze responsibly.",
            "A second sentence gives the quality gate enough structure to treat the recovered captions as usable."
          ].join(" "),
          segments: [
            {
              startMs: 0,
              durationMs: 9000,
              text: "This short clip still includes a full sentence with enough transcript detail to analyze responsibly."
            },
            {
              startMs: 9000,
              durationMs: 9000,
              text: "A second sentence gives the quality gate enough structure to treat the recovered captions as usable."
            }
          ],
          languageCode: "en",
          originalLanguageCode: "en",
          warnings: ["backend_yt_dlp_test"],
          sourceConfidence: "high"
        }),
        headlessResolver: async () => ({
          ok: false,
          errorCode: "backend_headless_failed",
          errorMessage: "Should not run after yt-dlp success."
        })
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.originKind).toBe("manual_caption_track");
    expect(result.qualityGate?.eligible).toBeTruthy();
    expect(result.qualityGate?.effectiveMinWordCount).toBeLessThan(120);
    expect(result.qualityGate?.effectiveMinSentenceUnits).toBeLessThan(3);
  });

  test("accepts yt-dlp subtitles even when the process exits nonzero after writing them", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "240"
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const ytDlpScript = [
      "const fs=require('fs');",
      "const args=process.argv.slice(1);",
      "const outIndex=args.indexOf('-o');",
      "const outputTemplate=args[outIndex+1];",
      "const outputPath=outputTemplate.replace('%(id)s','scriptlensvideo').replace('%(ext)s','en.json3');",
      "const payload={events:Array.from({length:16},(_,index)=>({tStartMs:index*12000,dDurationMs:10000,segs:[{utf8:`Nonzero subtitle segment ${index+1} still leaves a usable transcript on disk for backend recovery.`}]}))};",
      "fs.writeFileSync(outputPath,JSON.stringify(payload));",
      "process.stderr.write('warning after subtitle write');",
      "process.exit(1);"
    ].join("");

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=nonzeroexit01",
        requestedLanguageCode: "en",
        allowAutomaticAsr: false
      },
      {
        fetchImpl,
        ytDlpCommand: [process.execPath, "-e", ytDlpScript, "--"],
        headlessResolver: async () => ({
          ok: false,
          errorCode: "backend_headless_failed",
          errorMessage: "Should not run after yt-dlp success."
        })
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.warnings).toContain("backend_yt_dlp_nonzero_exit");
    const ytDlpStage = result.stageTelemetry.find((entry) => entry.stage === "yt-dlp-captions");
    expect(ytDlpStage?.detail?.attempts?.[0]?.failureKind).toBe("exit_nonzero_with_subtitle");
    expect(ytDlpStage?.detail?.attempts?.[0]?.chosenSubtitleFile).toContain(".json3");
  });

  test("accepts srv3 subtitles from the yt-dlp best-format attempt", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "360"
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const ytDlpScript = [
      "const fs=require('fs');",
      "const args=process.argv.slice(1);",
      "const outIndex=args.indexOf('-o');",
      "const outputTemplate=args[outIndex+1];",
      "const formatIndex=args.indexOf('--sub-format');",
      "const format=formatIndex>=0?args[formatIndex+1]:'best';",
      "if(format==='json3'||format==='vtt'){process.exit(0);}",
      "const outputPath=outputTemplate.replace('%(id)s','scriptlensvideo').replace('%(ext)s','en.srv3');",
      "const segments=[];",
      "for(let i=0;i<24;i+=1){segments.push(`<text start=\"${i*4}s\" dur=\"4s\">srv3 subtitle segment ${i+1} carries unique detail for transcript scoring and backend recovery coverage.</text>`);}",
      "fs.writeFileSync(outputPath,`<transcript>${segments.join('')}</transcript>`);"
    ].join("");

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=srv3fallback9",
        requestedLanguageCode: "en",
        includeTimestamps: true,
        allowAutomaticAsr: false
      },
      {
        fetchImpl,
        ytDlpCommand: [process.execPath, "-e", ytDlpScript, "--"],
        headlessResolver: async () => ({
          ok: false,
          errorCode: "backend_headless_failed",
          errorMessage: "Should not run after yt-dlp fallback."
        })
      }
    );

    expect(result.ok).toBeTruthy();
    const ytDlpStage = result.stageTelemetry.find((entry) => entry.stage === "yt-dlp-captions");
    expect(ytDlpStage?.detail?.selectedFormat).toBe("best");
    expect(ytDlpStage?.detail?.chosenSubtitleFile).toContain(".srv3");
  });

  test("passes operator-managed cookie auth to yt-dlp without leaking the cookie path", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "360"
        }
      }
    });
    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const cookieFilePath = "C:\\secret\\youtube-cookies.txt";
    const ytDlpScript = [
      "const fs=require('fs');",
      "const args=process.argv.slice(1);",
      "const cookieIndex=args.indexOf('--cookies');",
      "if(cookieIndex===-1||!args[cookieIndex+1]){process.stderr.write('missing cookies');process.exit(3);}",
      "const outIndex=args.indexOf('-o');",
      "const outputTemplate=args[outIndex+1];",
      "const outputPath=outputTemplate.replace('%(id)s','scriptlensvideo').replace('%(ext)s','en.vtt');",
      "const cues=['WEBVTT'];",
      "for(let i=0;i<20;i+=1){const start=i*4;const end=start+4;const stamp=(value)=>`00:00:${String(value).padStart(2,'0')}.000`;cues.push('',`${stamp(start)} --> ${stamp(end)}`,`Authenticated subtitle segment ${i+1} carries enough detail to satisfy transcript scoring while proving yt-dlp received the cookie flag.`);}",
      "fs.writeFileSync(outputPath,cues.join('\\n'));"
    ].join("");

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=authcookie123",
        requestedLanguageCode: "en",
        allowAutomaticAsr: false
      },
      {
        fetchImpl,
        ytDlpCommand: [process.execPath, "-e", ytDlpScript, "--"],
        headlessResolver: async () => ({
          ok: false,
          errorCode: "backend_headless_failed",
          errorMessage: "Should not run after yt-dlp success."
        }),
        policyOverrides: {
          backend: {
            auth: {
              mode: "cookie-file",
              cookieFilePath,
              useForYtDlp: true,
              useForBrowserSession: false
            }
          }
        }
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.authenticatedModeEnabled).toBeTruthy();
    expect(result.authenticatedAcquisitionUsed).toBeTruthy();
    expect(result.acquisitionPathUsed).toBe("authenticated-yt-dlp-captions");
    const ytDlpStage = result.stageTelemetry.find((entry) => entry.stage === "yt-dlp-captions");
    expect(ytDlpStage?.detail?.attempts?.[0]?.args).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain(cookieFilePath);
  });

  test("runs ASR only after transcript-class recovery fails quality gates", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "210"
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=asr12345678",
        requestedLanguageCode: "en",
        allowAutomaticAsr: true,
        maxAutomaticAsrDurationSeconds: 600
      },
      {
        fetchImpl,
        ytDlpResolver: async () => ({
          ok: true,
          text: "tiny output",
          segments: [
            {
              startMs: 0,
              durationMs: 2000,
              text: "tiny output"
            }
          ],
          languageCode: "en",
          originalLanguageCode: "en"
        }),
        headlessResolver: async () => ({
          ok: false,
          errorCode: "backend_headless_failed",
          errorMessage: "No headless transcript."
        }),
        asrResolver: async () => ({
          ok: true,
          text: Array.from({ length: 14 }, (_, index) => {
            return `ASR segment ${index + 1} contains enough spoken detail to satisfy the stricter audio-derived transcript quality gate.`;
          }).join("\n"),
          segments: Array.from({ length: 14 }, (_, index) => ({
            startMs: index * 12000,
            durationMs: 10000,
            text: `ASR segment ${index + 1} contains enough spoken detail to satisfy the stricter audio-derived transcript quality gate.`
          })),
          languageCode: "en",
          originalLanguageCode: "en",
          sourceConfidence: "low",
          warnings: ["asr_test_path"]
        })
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.strategy).toBe("backend-asr");
    expect(result.recoveryTier).toBe("hosted_asr");
    expect(result.originKind).toBe("audio_asr");
    expect(result.sourceTrustTier).toBe("audio-derived");
    expect(result.warnings).toContain("backend_audio_asr");
    expect(result.warnings).toContain("asr_test_path");
    expect(result.qualityGate?.eligible).toBeTruthy();
  });

  test("keeps transcript-class winners ahead of audio-derived fallback", async () => {
    let asrCalls = 0;
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "360"
        },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                baseUrl: "https://captions.example/manual",
                languageCode: "en",
                kind: "",
                name: { simpleText: "English" }
              }
            ]
          }
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      if (String(url).startsWith("https://captions.example/manual")) {
        return makeTextResponse(
          JSON.stringify({
            events: Array.from({ length: 18 }, (_, index) => ({
              tStartMs: index * 18000,
              dDurationMs: 17000,
              segs: [
                {
                  utf8: `Manual caption segment ${index + 1} keeps transcript recovery strong enough that ASR should never run.`
                }
              ]
            }))
          })
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=manualbeatsasr",
        requestedLanguageCode: "en",
        allowAutomaticAsr: true,
        maxAutomaticAsrDurationSeconds: 900
      },
      {
        fetchImpl,
        asrResolver: async () => {
          asrCalls += 1;
          return {
            ok: true,
            text: "This path should never execute.",
            segments: []
          };
        }
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.originKind).toBe("manual_caption_track");
    expect(result.recoveryTier).toBe("hosted_transcript");
    expect(asrCalls).toBe(0);
    expect(result.stageTelemetry.some((entry) => entry.stage === "audio-asr")).toBeFalsy();
  });

  test("runs the default command-based ASR pipeline with audio telemetry", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "180"
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const asrScript = [
      "const fs=require('fs');",
      "const [audioPath,outputPath,requestedLanguage]=process.argv.slice(1);",
      "if(!audioPath.endsWith('.mp3')){process.stderr.write('audio path missing');process.exit(2);}",
      "const payload={",
      "text:Array.from({length:14},(_,index)=>`ASR command segment ${index+1} contains enough detail to satisfy the bounded audio fallback quality gate.`).join('\\n'),",
      "segments:Array.from({length:14},(_,index)=>({startMs:index*12000,durationMs:10000,text:`ASR command segment ${index+1} contains enough detail to satisfy the bounded audio fallback quality gate.`})),",
      "languageCode:requestedLanguage||'en',",
      "originalLanguageCode:requestedLanguage||'en',",
      "sourceConfidence:'low',",
      "detail:{engine:'test-asr',model:'tiny.en',languageProbability:0.88}",
      "};",
      "fs.writeFileSync(outputPath,JSON.stringify(payload));"
    ].join("");

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=asrcommand000",
        requestedLanguageCode: "en",
        allowAutomaticAsr: true,
        maxAutomaticAsrDurationSeconds: 600
      },
      {
        fetchImpl,
        ytDlpResolver: async () => ({
          ok: false,
          errorCode: "yt_dlp_failed",
          errorMessage: "No subtitle file."
        }),
        headlessResolver: async () => ({
          ok: false,
          errorCode: "backend_headless_failed",
          errorMessage: "No headless transcript."
        }),
        audioDownloadResolver: async () => ({
          ok: true,
          audioFilePath: "C:\\temp\\scriptlens-audio.mp3",
          detail: {
            selectedAudioFile: "scriptlens-audio.mp3",
            source: "test-download"
          },
          videoDurationSeconds: 180
        }),
        asrCommand: [process.execPath, "-e", asrScript, "--"],
        asrArgs: ["{audioPath}", "{outputPath}", "{requestedLanguageCode}"]
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.originKind).toBe("audio_asr");
    expect(result.sourceTrustTier).toBe("audio-derived");
    expect(result.recoveryTier).toBe("hosted_asr");
    expect(result.warnings).toContain("backend_audio_asr");
    expect(result.warnings).toContain("backend_asr_command");
    const asrStage = result.stageTelemetry.find(
      (entry) => entry.stage === "audio-asr" && entry.type === "stage"
    );
    expect(asrStage?.detail?.audioDownload?.selectedAudioFile).toBe("scriptlens-audio.mp3");
    expect(asrStage?.detail?.asr?.source).toBe("custom-command");
    expect(asrStage?.detail?.asr?.model).toBe("tiny.en");
    expect(asrStage?.detail?.asr?.parseResult).toBe("success");
  });

  test("downloads raw bestaudio for ASR without forcing mp3 transcoding", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "180"
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const ytDlpScript = [
      "const fs=require('fs');",
      "const args=process.argv.slice(1);",
      "if(args.includes('--extract-audio')){process.stderr.write('unexpected transcode');process.exit(7);}",
      "const runtimeIndex=args.indexOf('--js-runtimes');",
      "if(runtimeIndex<0||args[runtimeIndex+1]!=='node'){process.stderr.write('missing js runtime');process.exit(6);}",
      "const formatIndex=args.indexOf('-f');",
      "if(formatIndex<0||args[formatIndex+1]!=='bestaudio/best'){process.stderr.write('missing bestaudio format');process.exit(8);}",
      "const outIndex=args.indexOf('-o');",
      "const outputTemplate=args[outIndex+1];",
      "const outputPath=outputTemplate.replace('%(id)s','scriptlensaudio').replace('%(ext)s','m4a');",
      "fs.writeFileSync(outputPath,'audio payload');"
    ].join("");

    const asrScript = [
      "const fs=require('fs');",
      "const [audioPath,outputPath]=process.argv.slice(1);",
      "if(!audioPath.endsWith('.m4a')){process.stderr.write(`unexpected audio path: ${audioPath}`);process.exit(9);}",
      "const payload={",
      "text:Array.from({length:14},(_,index)=>`Audio fallback segment ${index+1} contains enough detail to satisfy the bounded ASR quality gate.`).join('\\n'),",
      "segments:Array.from({length:14},(_,index)=>({startMs:index*12000,durationMs:10000,text:`Audio fallback segment ${index+1} contains enough detail to satisfy the bounded ASR quality gate.`})),",
      "languageCode:'en',",
      "originalLanguageCode:'en',",
      "sourceConfidence:'low',",
      "detail:{engine:'test-asr',model:'tiny.en'}",
      "};",
      "fs.writeFileSync(outputPath,JSON.stringify(payload));"
    ].join("");

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=rawaudio0000",
        requestedLanguageCode: "en",
        allowAutomaticAsr: true,
        maxAutomaticAsrDurationSeconds: 600
      },
      {
        fetchImpl,
        ytDlpResolver: async () => ({
          ok: false,
          errorCode: "yt_dlp_failed",
          errorMessage: "No subtitle file."
        }),
        headlessResolver: async () => ({
          ok: false,
          errorCode: "backend_headless_failed",
          errorMessage: "No headless transcript."
        }),
        ytDlpCommand: [process.execPath, "-e", ytDlpScript, "--"],
        asrCommand: [process.execPath, "-e", asrScript, "--"],
        asrArgs: ["{audioPath}", "{outputPath}"]
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.originKind).toBe("audio_asr");
    const asrStage = result.stageTelemetry.find(
      (entry) => entry.stage === "audio-asr" && entry.type === "stage"
    );
    expect(asrStage?.detail?.audioDownload?.selectedAudioFile).toBe("scriptlensaudio.m4a");
    expect(asrStage?.detail?.audioDownload?.args).toContain("--js-runtimes");
    expect(asrStage?.detail?.audioDownload?.args).toContain("node");
    expect(asrStage?.detail?.audioDownload?.args).toContain("-f");
    expect(asrStage?.detail?.audioDownload?.args).toContain("bestaudio/best");
    expect(asrStage?.detail?.audioDownload?.args).not.toContain("--extract-audio");
  });

  test("prefers observed browser-session audio candidates over video streams", () => {
    const candidate = selectBrowserSessionMediaCandidate([
      {
        url: "https://rr1.googlevideo.com/videoplayback?mime=video%2Fmp4&clen=400",
        ok: true,
        status: 200,
        resourceType: "media",
        mimeType: "video/mp4",
        queryMimeType: "video/mp4",
        container: "m4a",
        isAudioCandidate: false,
        contentLength: 400,
        score: 10
      },
      {
        url: "https://rr2.googlevideo.com/videoplayback?mime=audio%2Fwebm&clen=900",
        ok: true,
        status: 206,
        resourceType: "media",
        mimeType: "audio/webm",
        queryMimeType: "audio/webm",
        container: "webm",
        isAudioCandidate: true,
        contentLength: 900
      },
      {
        url: "https://rr3.googlevideo.com/videoplayback?mime=audio%2Fmp4&clen=1200",
        ok: true,
        status: 200,
        resourceType: "media",
        mimeType: "audio/mp4",
        queryMimeType: "audio/mp4",
        container: "m4a",
        isAudioCandidate: true,
        contentLength: 1200
      }
    ]);

    expect(candidate?.url).toContain("audio%2Fmp4");
    expect(candidate?.container).toBe("m4a");
    expect(candidate?.mimeType).toBe("audio/mp4");
  });

  test("downloads observed browser-session audio and records mime telemetry", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptlens-browser-audio-test-"));
    try {
      const result = await downloadObservedBrowserSessionMedia(
        {
          url: "https://rr3.googlevideo.com/videoplayback?mime=audio%2Fmp4&clen=4",
          ok: true,
          status: 200,
          resourceType: "media",
          mimeType: "audio/mp4",
          queryMimeType: "audio/mp4",
          container: "m4a",
          isAudioCandidate: true,
          contentLength: 4,
          requestHeaders: {
            referer: "https://www.youtube.com/watch?v=browseraudio1",
            "user-agent": "ScriptLens test agent"
          }
        },
        {
          fetchImpl: async () =>
            makeBinaryResponse(Uint8Array.from([1, 2, 3, 4]), {
              status: 200,
              headers: {
                "content-type": "audio/mp4",
                "content-length": "4"
              }
            }),
          outputDir,
          watchUrl: "https://www.youtube.com/watch?v=browseraudio1"
        }
      );

      expect(result.ok).toBeTruthy();
      expect(result.container).toBe("m4a");
      expect(result.mimeType).toBe("audio/mp4");
      expect(path.basename(result.audioFilePath)).toBe("scriptlens-browser-audio.m4a");
      const bytes = await fs.readFile(result.audioFilePath);
      expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
      expect(result.detail?.downloadedBytes).toBe(4);
      expect(result.detail?.requests?.[0]?.contentType).toBe("audio/mp4");
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  test("surfaces browser-session audio download HTTP failures", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptlens-browser-audio-fail-"));
    try {
      const result = await downloadObservedBrowserSessionMedia(
        {
          url: "https://rr4.googlevideo.com/videoplayback?mime=audio%2Fmp4&clen=8",
          ok: true,
          status: 200,
          resourceType: "media",
          mimeType: "audio/mp4",
          queryMimeType: "audio/mp4",
          container: "m4a",
          isAudioCandidate: true,
          contentLength: 8,
          requestHeaders: {
            referer: "https://www.youtube.com/watch?v=browseraudiofail"
          }
        },
        {
          fetchImpl: async () =>
            makeBinaryResponse(new Uint8Array(), {
              status: 403,
              headers: {
                "content-type": "text/plain"
              }
            }),
          outputDir,
          watchUrl: "https://www.youtube.com/watch?v=browseraudiofail"
        }
      );

      expect(result.ok).toBeFalsy();
      expect(result.errorCode).toBe("asr_audio_browser_session_http_403");
      expect(result.detail?.failureKind).toBe("http_failure");
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  test("falls back to browser-session audio when yt-dlp is bot-gated", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "180"
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const ytDlpAudioScript = [
      "process.stderr.write('Sign in to confirm you\\'re not a bot');",
      "process.exit(1);"
    ].join("");

    const asrScript = [
      "const fs=require('fs');",
      "const [audioPath,outputPath]=process.argv.slice(1);",
      "if(!audioPath.endsWith('.m4a')){process.stderr.write(`unexpected audio path: ${audioPath}`);process.exit(9);} ",
      "const payload={",
      "text:Array.from({length:14},(_,index)=>`Browser audio segment ${index+1} contains enough detail to satisfy the bounded ASR quality gate.`).join('\\n'),",
      "segments:Array.from({length:14},(_,index)=>({startMs:index*12000,durationMs:10000,text:`Browser audio segment ${index+1} contains enough detail to satisfy the bounded ASR quality gate.`})),",
      "languageCode:'en',",
      "originalLanguageCode:'en',",
      "sourceConfidence:'low',",
      "};",
      "fs.writeFileSync(outputPath,JSON.stringify(payload));"
    ].join("");

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=browseraudiook",
        requestedLanguageCode: "en",
        allowAutomaticAsr: true,
        maxAutomaticAsrDurationSeconds: 600
      },
      {
        fetchImpl,
        ytDlpResolver: async () => ({
          ok: false,
          errorCode: "yt_dlp_failed",
          errorMessage: "No subtitle file."
        }),
        headlessResolver: async () => ({
          ok: false,
          errorCode: "backend_headless_failed",
          errorMessage: "No headless transcript."
        }),
        ytDlpCommand: [process.execPath, "-e", ytDlpAudioScript, "--"],
        browserSessionAudioResolver: async ({ outputDir }) => {
          const audioPath = path.join(outputDir, "sessionaudio.m4a");
          await fs.writeFile(audioPath, "headless audio payload");
          return {
            ok: true,
            audioFilePath: audioPath,
            mimeType: "audio/mp4",
            container: "m4a",
            detail: {
              acquisitionStrategy: "browser-session",
              selectedAudioFile: "sessionaudio.m4a",
              selectedMimeType: "audio/mp4",
              selectedContainer: "m4a",
              selectedCandidate: {
                url: "https://rr5.googlevideo.com/videoplayback?mime=audio%2Fmp4",
                mimeType: "audio/mp4",
                container: "m4a"
              }
            },
            videoDurationSeconds: 180
          };
        },
        asrCommand: [process.execPath, "-e", asrScript, "--"],
        asrArgs: ["{audioPath}", "{outputPath}"]
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.originKind).toBe("audio_asr");
    expect(result.warnings).toContain("asr_audio_browser_session_fallback");
    const asrStage = result.stageTelemetry.find(
      (entry) => entry.stage === "audio-asr" && entry.type === "stage"
    );
    expect(asrStage?.detail?.audioDownload?.acquisitionStrategy).toBe("browser-session");
    expect(asrStage?.detail?.audioDownload?.botGateDetected).toBeTruthy();
    expect(asrStage?.detail?.audioDownload?.ytDlp?.failureKind).toBe("bot_gate");
    expect(asrStage?.detail?.audioDownload?.browserSession?.selectedAudioFile).toBe("sessionaudio.m4a");
  });

  test("allows ASR when headless failure still inferred the video duration", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {}
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=headlessduration1",
        requestedLanguageCode: "en",
        allowAutomaticAsr: true,
        maxAutomaticAsrDurationSeconds: 600
      },
      {
        fetchImpl,
        ytDlpResolver: async () => ({
          ok: false,
          errorCode: "yt_dlp_failed",
          errorMessage: "No subtitle file."
        }),
        headlessResolver: async ({ headlessDetail }) => {
          headlessDetail.lastKnownState = {
            videoDurationSeconds: 180
          };
          return {
            ok: false,
            errorCode: "backend_headless_panel_failed",
            errorMessage: "No transcript controls."
          };
        },
        asrResolver: async () => ({
          ok: true,
          text: Array.from({ length: 14 }, (_, index) => {
            return `Duration-aware ASR segment ${index + 1} contains enough detail to satisfy the bounded ASR quality gate.`;
          }).join("\n"),
          segments: Array.from({ length: 14 }, (_, index) => ({
            startMs: index * 12000,
            durationMs: 10000,
            text: `Duration-aware ASR segment ${index + 1} contains enough detail to satisfy the bounded ASR quality gate.`
          })),
          languageCode: "en",
          originalLanguageCode: "en",
          sourceConfidence: "low"
        })
      }
    );

    expect(result.ok).toBeTruthy();
    expect(result.originKind).toBe("audio_asr");
    expect(result.videoDurationSeconds).toBe(180);
    const decisionStage = result.stageTelemetry.find(
      (entry) => entry.stage === "audio-asr" && entry.type === "asr-decision"
    );
    expect(decisionStage?.outcome).toBe("eligible");
    expect(decisionStage?.detail?.durationSeconds).toBe(180);
  });

  test("skips ASR when the configured duration cap would be exceeded", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "3600"
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=longasr1234",
        requestedLanguageCode: "en",
        allowAutomaticAsr: true,
        maxAutomaticAsrDurationSeconds: 300
      },
      {
        fetchImpl,
        ytDlpResolver: async () => ({
          ok: false,
          errorCode: "yt_dlp_failed",
          errorMessage: "No subtitle file."
        }),
        headlessResolver: async () => ({
          ok: false,
          errorCode: "backend_headless_failed",
          errorMessage: "No headless transcript."
        }),
        asrResolver: async () => ({
          ok: true,
          text: "This path should never execute.",
          segments: []
        })
      }
    );

    expect(result.ok).toBeFalsy();
    expect(result.errorCode).toBe("asr_duration_limit");
    expect(result.warnings).toContain("asr_duration_limit");
  });

  test("surfaces backend timeout failure codes explicitly", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "180"
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=ghi789rst12"
      },
      {
        fetchImpl,
        totalTimeoutMs: 5000,
        ytDlpResolver: async () => ({
          ok: false,
          errorCode: "yt_dlp_failed",
          errorMessage: "No subtitle file."
        }),
        headlessStageTimeoutMs: 200,
        headlessResolver: ({ signal, headlessDetail }) =>
          new Promise((resolve, reject) => {
            headlessDetail.steps.push({
              step: "openTranscript",
              outcome: "success",
              durationMs: 12,
              detail: {
                route: "test-pre-timeout"
              }
            });
            signal.addEventListener(
              "abort",
              () => {
                const error = new Error("timeout");
                error.stageDetail = headlessDetail;
                reject(error);
              },
              { once: true }
            );
          })
      }
    );

    expect(result.ok).toBeFalsy();
    expect(result.errorCode).toBe("backend_timeout");
    expect(result.warnings).toContain("backend_timeout");
    expect(result.quality).toBe("enhanced-extraction-unavailable");
    expect(result).toHaveProperty("sourceConfidence");
    expect(result).toHaveProperty("transcriptSpanSeconds");
    expect(result).toHaveProperty("videoDurationSeconds");
    expect(result).toHaveProperty("warnings");
    const headlessStage = result.stageTelemetry.find((entry) => entry.stage === "headless-transcript-panel");
    expect(headlessStage?.detail?.steps?.[0]?.step).toBe("openTranscript");
    expect(headlessStage?.detail?.steps?.[0]?.detail?.route).toBe("test-pre-timeout");
  });

  test("preserves partial yt-dlp stdout and stderr when the subtitle stage times out", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "180"
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const ytDlpScript = [
      "process.stdout.write('subtitle bootstrap started\\n');",
      "process.stderr.write('subtitle bootstrap waiting\\n');",
      "setInterval(() => {}, 1000);"
    ].join("");

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=ytdlptimeout1",
        requestedLanguageCode: "en",
        allowAutomaticAsr: false
      },
      {
        fetchImpl,
        totalTimeoutMs: 5000,
        ytDlpStageTimeoutMs: 250,
        ytDlpCommand: [process.execPath, "-e", ytDlpScript, "--"],
        headlessResolver: async () => ({
          ok: false,
          errorCode: "backend_headless_failed",
          errorMessage: "No headless transcript."
        })
      }
    );

    expect(result.ok).toBeFalsy();
    expect(result.errorCode).toBe("backend_timeout");
    const ytDlpStage = result.stageTelemetry.find((entry) => entry.stage === "yt-dlp-captions");
    expect(ytDlpStage?.errorCode).toBe("backend_timeout");
    expect(ytDlpStage?.detail?.attempts?.[0]?.failureKind).toBe("timeout");
    expect(ytDlpStage?.detail?.attempts?.[0]?.stdoutTail).toContain("subtitle bootstrap started");
    expect(ytDlpStage?.detail?.attempts?.[0]?.stderrTail).toContain("subtitle bootstrap waiting");
  });

  test("short-circuits yt-dlp retries when YouTube bot-gates subtitle fetches", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "240"
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const ytDlpScript = [
      "process.stderr.write('ERROR: Sign in to confirm you\\'re not a bot\\n');",
      "process.exit(1);"
    ].join("");

    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=botgate12345",
        requestedLanguageCode: "en",
        allowAutomaticAsr: false
      },
      {
        fetchImpl,
        ytDlpCommand: [process.execPath, "-e", ytDlpScript, "--"],
        headlessResolver: async () => ({
          ok: false,
          errorCode: "backend_headless_failed",
          errorMessage: "Headless should still run after yt-dlp bot-gate."
        })
      }
    );

    const ytDlpStage = result.stageTelemetry.find((entry) => entry.stage === "yt-dlp-captions");
    expect(ytDlpStage?.errorCode).toBe("yt_dlp_exit_nonzero");
    expect(ytDlpStage?.detail?.botGateDetected).toBeTruthy();
    expect(ytDlpStage?.detail?.attempts?.length).toBe(1);
    expect(ytDlpStage?.detail?.attempts?.[0]?.failureKind).toBe("bot_gate");
  });

  test("launches headless Chromium with Cloud Run-safe args and reports granular launch failures", async () => {
    const html = buildWatchHtml({
      playerResponse: {
        videoDetails: {
          lengthSeconds: "180"
        }
      }
    });

    const fetchImpl = async (url) => {
      if (/youtube\.com\/watch/.test(String(url))) {
        return makeTextResponse(html);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    let launchOptions = null;
    const result = await resolveTranscriptRequest(
      {
        url: "https://www.youtube.com/watch?v=headless1234"
      },
      {
        fetchImpl,
        policyOverrides: {
          backend: {
            headless: {
              extraLaunchArgs: ["--remote-debugging-pipe"]
            }
          }
        },
        chromiumLauncher: {
          launch: async (options) => {
            launchOptions = options;
            throw new Error("browser launch failed");
          }
        }
      }
    );

    expect(result.ok).toBeFalsy();
    expect(launchOptions.chromiumSandbox).toBeFalsy();
    expect(launchOptions.args).toContain("--no-sandbox");
    expect(launchOptions.args).toContain("--remote-debugging-pipe");
    const headlessStage = result.stageTelemetry.find((entry) => entry.stage === "headless-transcript-panel");
    expect(headlessStage?.errorCode).toBe("backend_headless_launch_failed");
    expect(headlessStage?.detail?.launchOptions?.args).toContain("--disable-dev-shm-usage");
    expect(headlessStage?.detail?.steps?.[0]?.step).toBe("launch");
    expect(headlessStage?.detail?.steps?.[0]?.outcome).toBe("failure");
  });
});

function buildWatchHtml({ playerResponse = {}, initialData = {}, ytcfg = {} }) {
  return `<!doctype html>
  <html lang="en">
    <head><meta charset="utf-8"><title>ScriptLens test video</title></head>
    <body>
      <script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script>
      <script>var ytInitialData = ${JSON.stringify(initialData)};</script>
      <script>ytcfg.set(${JSON.stringify(ytcfg)});</script>
    </body>
  </html>`;
}

function makeTextResponse(text) {
  return {
    ok: true,
    status: 200,
    text: async () => text
  };
}

function makeBinaryResponse(bytes, options = {}) {
  const payload = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
  const headers = Object.fromEntries(
    Object.entries(options.headers || {}).map(([key, value]) => [String(key).toLowerCase(), String(value)])
  );
  const status = Number(options.status || 200);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key) => headers[String(key || "").toLowerCase()] || null
    },
    arrayBuffer: async () =>
      payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
  };
}
