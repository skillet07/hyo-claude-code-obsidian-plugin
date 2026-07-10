export function clearComposerAfterAcceptedSend(
  accepted: boolean,
  clear: () => void,
): void {
  if (accepted) clear();
}
