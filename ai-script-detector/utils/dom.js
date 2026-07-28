(function (root) {
  const App = (root.AIScriptDetector = root.AIScriptDetector || {});
  const Text = App.text;

  const BLOCK_SELECTOR = [
    "article",
    "main",
    "section",
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "blockquote",
    "figcaption",
    "pre",
    "td",
    "th"
  ].join(",");

  const ROOT_CANDIDATES = [
    { selector: "article", kind: "article-content" },
    { selector: ".article", kind: "article-content" },
    { selector: ".post", kind: "article-content" },
    { selector: ".entry-content", kind: "article-content" },
    { selector: ".story", kind: "article-content" },
    { selector: "main", kind: "page-content" },
    { selector: "[role='main']", kind: "page-content" },
    { selector: ".content", kind: "page-content" },
    { selector: "#content", kind: "page-content" }
  ];

  const IGNORE_SELECTOR = [
    "script",
    "style",
    "noscript",
    "svg",
    "canvas",
    "img",
    "picture",
    "video",
    "audio",
    "iframe",
    "button",
    "input",
    "textarea",
    "select",
    "option",
    "label",
    "form",
    "nav",
    "footer",
    "aside",
    "[aria-hidden='true']",
    "[hidden]",
    "[role='navigation']"
  ].join(",");

  App.dom = {
    extractVisibleDocumentText,
    extractVisibleDocumentPayload
  };

  function extractVisibleDocumentText(doc) {
    return extractVisibleDocumentPayload(doc).text;
  }

  function extractVisibleDocumentPayload(doc) {
    const rootInfo = findContentRoot(doc) || {
      element: doc.body,
      selector: "body",
      kind: "page-content"
    };
    const root = rootInfo.element;
    if (!root) {
      return {
        text: "",
        metadata: buildMetadata("", "", 0, rootInfo)
      };
    }

    const seen = new Set();
    const blocks = [];

    root.querySelectorAll(BLOCK_SELECTOR).forEach((element) => {
      if (!shouldKeepElement(element, root)) {
        return;
      }

      const text = cleanBlockText(element.innerText || element.textContent || "");
      if (!text || seen.has(text)) {
        return;
      }

      seen.add(text);
      blocks.push(text);
    });

    const extractedText =
      blocks.length >= 4 ? blocks.join("\n\n") : extractFromTreeWalker(doc, root, seen);
    const visibleText = cleanDocumentText(root.innerText || root.textContent || "");

    return {
      text: extractedText,
      metadata: buildMetadata(extractedText, visibleText, blocks.length, rootInfo)
    };
  }

  function buildMetadata(extractedText, visibleText, blockCount, rootInfo) {
    const extractedWordCount = Text.countWords(extractedText);
    const visibleWordCount = Math.max(extractedWordCount, Text.countWords(visibleText));
    const coverageRatio =
      visibleWordCount > 0 ? extractedWordCount / Math.max(visibleWordCount, 1) : 0;
    const normalizedCoverage = roundTo(coverageRatio, 3);
    const contentKind = deriveContentKind(
      rootInfo?.kind || "page-content",
      extractedWordCount,
      blockCount,
      normalizedCoverage
    );

    return {
      blockCount,
      extractedWordCount,
      visibleWordCount,
      coverageRatio: normalizedCoverage,
      contentKind,
      rootSelector: rootInfo?.selector || "body",
      rootTag: rootInfo?.element?.tagName?.toLowerCase?.() || "body"
    };
  }

  function findContentRoot(doc) {
    for (const candidate of ROOT_CANDIDATES) {
      const element = doc.querySelector(candidate.selector);
      if (element && isElementVisible(element)) {
        return {
          element,
          selector: candidate.selector,
          kind: candidate.kind
        };
      }
    }
    return {
      element: doc.body,
      selector: "body",
      kind: "page-content"
    };
  }

  function deriveContentKind(baseKind, extractedWordCount, blockCount, coverageRatio) {
    if (baseKind === "article-content") {
      return "article-content";
    }

    if (extractedWordCount >= 220 && blockCount >= 5 && coverageRatio >= 0.18) {
      return "article-content";
    }

    return "page-content";
  }

  function shouldKeepElement(element, root) {
    if (!element || element === root || !isElementVisible(element)) {
      return false;
    }

    if (element.closest(IGNORE_SELECTOR)) {
      return false;
    }

    const text = cleanBlockText(element.innerText || element.textContent || "");
    if (!text) {
      return false;
    }

    const linkTextLength = Array.from(element.querySelectorAll("a")).reduce((sum, link) => {
      return sum + cleanBlockText(link.innerText || link.textContent || "").length;
    }, 0);

    if (text.length && linkTextLength / text.length > 0.65) {
      return false;
    }

    const wordCount = Text.countWords(text);
    if (element.matches("p, li, blockquote, pre, td, th")) {
      return wordCount >= 3;
    }

    return wordCount >= 2 || /[.!?]/.test(text);
  }

  function extractFromTreeWalker(doc, root, seen) {
    const walker = doc.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || parent.closest(IGNORE_SELECTOR) || !isElementVisible(parent)) {
            return NodeFilter.FILTER_REJECT;
          }
          const text = cleanBlockText(node.textContent || "");
          if (!text || seen.has(text)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const parts = [];
    while (walker.nextNode()) {
      const text = cleanBlockText(walker.currentNode.textContent || "");
      if (!text || seen.has(text)) {
        continue;
      }
      seen.add(text);
      parts.push(text);
    }

    return parts.join("\n\n");
  }

  function isElementVisible(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }

    return element.getClientRects().length > 0;
  }

  function cleanBlockText(value) {
    const text = Text.normalizeWhitespace(value)
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!text) {
      return "";
    }

    const wordCount = Text.countWords(text);
    if (wordCount <= 1 && text.length < 18) {
      return "";
    }

    return text;
  }

  function cleanDocumentText(value) {
    return Text.normalizeWhitespace(value).replace(/\s{2,}/g, " ").trim();
  }

  function roundTo(value, precision) {
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
  }
})(globalThis);
