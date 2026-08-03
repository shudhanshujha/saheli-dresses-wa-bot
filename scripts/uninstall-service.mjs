import { Service } from 'node-windows';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const svc = new Service({
  name: 'SaheliDressesWABot',
  script: path.join(rootDir, 'src', 'main.mjs')
});

svc.on('uninstall', () => {
  console.log('Uninstall complete.');
  console.log('The service exists:', svc.exists);
});

svc.on('alreadyuninstalled', () => {
  console.log('Service was already uninstalled.');
});

svc.on('error', (err) => console.error('Uninstall service error:', err));

svc.uninstall();
