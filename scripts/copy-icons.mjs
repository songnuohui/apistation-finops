import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const names=['layout-dashboard','users','landmark','chart-no-axes-combined','wallet-cards','scale','tags','refresh-cw','download','search','settings-2','circle-dollar-sign','receipt-text','shield-check','database-zap','server-cog','triangle-alert','activity','user-round-x','user-round-check','chevron-down','plus','x','panel-left-close','panel-left-open','log-out'];
const source=path.join(root,'node_modules','lucide-static','icons'),target=path.join(root,'web','icons');
await fs.mkdir(target,{recursive:true});
for(const name of names)await fs.copyFile(path.join(source,`${name}.svg`),path.join(target,`${name}.svg`));
console.log(`copied ${names.length} icons`);
