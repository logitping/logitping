import { rm } from 'node:fs/promises';

// tsup builds its configurations in parallel, so none of them can clean the shared output
// directory. Remove earlier outputs first: anything left in dist would be published.
for (const directory of ['dist', 'build']) {
  await rm(new URL(`../${directory}`, import.meta.url), { recursive: true, force: true });
}
