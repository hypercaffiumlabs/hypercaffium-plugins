#!/usr/bin/env node
// Terminal settings menu for this plugin (the only place critical features can be switched on).
// Built into dist/setup.mjs by `npm run build`. Run it yourself in a terminal: node <path>/setup.mjs
import { runSetup } from '../../shared/setup-cli.js';
import { CONFIG_PATH } from './config.js';

await runSetup({ store: 'google', configPath: CONFIG_PATH });
