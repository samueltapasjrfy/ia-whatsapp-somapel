import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = new URL('../knowledge/', import.meta.url).pathname;

// Carrega todos os .md da pasta knowledge/ (ordem alfabética), removendo comentários HTML.
export function loadKnowledge() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => readFileSync(join(DIR, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim())
    .join('\n\n=====================================================================\n\n');
}
