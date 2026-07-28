(function (root) {
  const App = (root.AIScriptDetector = root.AIScriptDetector || {});

  App.text = {
    sanitizeInput,
    normalizeWhitespace,
    splitParagraphs,
    splitSentences,
    tokenize,
    countWords,
    smartTruncate,
    preview
  };

  function sanitizeInput(value) {
    return normalizeWhitespace(String(value || ""));
  }

  function normalizeWhitespace(value) {
    return String(value || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function splitParagraphs(value) {
    return sanitizeInput(value)
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function splitSentences(value) {
    const segments = splitParagraphs(value).flatMap((paragraph) =>
      paragraph
        .split(/\n+/)
        .map((line) => normalizeWhitespace(line))
        .filter(Boolean)
    );

    return segments
      .flatMap((segment) => {
        const matches = segment.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || [segment];
        return matches.map((sentence) => normalizeWhitespace(sentence));
      })
      .filter((sentence) => sentence.length >= 20 || countWords(sentence) >= 4);
  }

  function tokenize(value) {
    return sanitizeInput(value).toLowerCase().match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g) || [];
  }

  function countWords(value) {
    return tokenize(value).length;
  }

  function smartTruncate(value, maxLength) {
    const text = sanitizeInput(value);
    if (text.length <= maxLength) {
      return {
        text,
        truncated: false
      };
    }

    const candidate = text.slice(0, maxLength);
    const punctuationIndex = Math.max(
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf("! "),
      candidate.lastIndexOf("? ")
    );
    const cutoff = punctuationIndex > maxLength * 0.7 ? punctuationIndex + 1 : maxLength;

    return {
      text: candidate.slice(0, cutoff).trim(),
      truncated: true
    };
  }

  function preview(value, maxLength) {
    const text = sanitizeInput(value);
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
  }
})(globalThis);
