import { execFile } from 'node:child_process';

export function openBrowser(url: string): void {
  const command = process.platform === 'darwin'
    ? { file: 'open', args: [url] }
    : process.platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '', url] }
      : { file: 'xdg-open', args: [url] };

  execFile(command.file, command.args, () => {
    // Opening is best-effort; callers also receive or print the URL.
  });
}