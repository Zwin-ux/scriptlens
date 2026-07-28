(function (root) {
  const App = (root.AIScriptDetector = root.AIScriptDetector || {});

  App.stats = {
    clamp,
    round,
    mean,
    variance,
    stdDev,
    coefficientOfVariation,
    normalizeRange,
    normalizeInverse
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function round(value) {
    return Math.round(Number(value) || 0);
  }

  function mean(values) {
    if (!Array.isArray(values) || !values.length) {
      return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function variance(values) {
    if (!Array.isArray(values) || values.length <= 1) {
      return 0;
    }
    const average = mean(values);
    return mean(values.map((value) => (value - average) ** 2));
  }

  function stdDev(values) {
    return Math.sqrt(variance(values));
  }

  function coefficientOfVariation(values) {
    const average = mean(values);
    if (!average) {
      return 0;
    }
    return stdDev(values) / average;
  }

  function normalizeRange(value, min, max) {
    if (max <= min) {
      return 0;
    }
    return clamp((value - min) / (max - min), 0, 1);
  }

  function normalizeInverse(value, min, max) {
    return 1 - normalizeRange(value, min, max);
  }
})(globalThis);
