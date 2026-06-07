export function isScrollContainerNearBottom(
  container: HTMLDivElement | null | undefined,
  thresholdPx = 24,
): boolean {
  if (!container) {
    return true;
  }

  const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
  return remaining <= thresholdPx;
}
