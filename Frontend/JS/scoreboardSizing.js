export function largestPlayerNameSize({ minimum, maximum, measure, iterations = 10, overflowLimit = null }) {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || typeof measure !== "function") return 0;
  const lowerBound = Math.min(minimum, maximum);
  const upperBound = Math.max(minimum, maximum);
  const baseline = measure(lowerBound);
  const allowedOverflow = Number.isFinite(overflowLimit)
    ? Math.max(0, overflowLimit)
    : Math.max(0, Number(baseline?.overflow) || 0) + 1;
  const fits = (fontSize) => {
    const result = measure(fontSize);
    return result?.widthFits === true && Math.max(0, Number(result.overflow) || 0) <= allowedOverflow;
  };

  if (fits(upperBound)) return upperBound;
  if (!fits(lowerBound)) return lowerBound;

  let lower = lowerBound;
  let upper = upperBound;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const candidate = (lower + upper) / 2;
    if (fits(candidate)) lower = candidate;
    else upper = candidate;
  }
  return lower;
}
