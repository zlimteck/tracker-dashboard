import topUserAgents from 'top-user-agents';

const USER_AGENTS = topUserAgents.length
  ? topUserAgents
  : [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  ];

let rotation: string[] = [];

function shuffled(items: string[]): string[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function selectUserAgent(): string {
  if (!rotation.length) rotation = shuffled(USER_AGENTS);
  return rotation.pop() ?? USER_AGENTS[0];
}
