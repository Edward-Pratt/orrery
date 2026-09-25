// npm run check-config [-- path]: validates config.json offline (no DISCORD_TOKEN, no network), same rules as startup.
import { loadConfig } from './config.ts';

const path = process.argv[2] ?? 'config.json';
try {
  loadConfig(path);
  console.log(`${path} OK`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
