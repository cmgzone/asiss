export const SHELL_STREAM_MARKER = '__SHELL_STREAM__';
export const SHELL_STREAM_END_MARKER = '__SHELL_STREAM_END__';

export function stripShellStreamMarker(chunk: string): { chunk: string; hadMarker: boolean; isEnd: boolean } {
  if (!chunk) return { chunk, hadMarker: false, isEnd: false };
  if (chunk.startsWith(SHELL_STREAM_END_MARKER)) {
    return { chunk: '', hadMarker: false, isEnd: true };
  }
  if (chunk.startsWith(SHELL_STREAM_MARKER)) {
    let stripped = chunk.slice(SHELL_STREAM_MARKER.length);
    if (stripped.startsWith('\n')) {
      stripped = stripped.slice(1);
    }
    return { chunk: stripped, hadMarker: true, isEnd: false };
  }
  return { chunk, hadMarker: false, isEnd: false };
}
