import './migrations.js';
import { installRuntimeGuards, runStartupIntegrityChecks } from './resilience.js';

runStartupIntegrityChecks();
installRuntimeGuards();

await import('./app.js');
