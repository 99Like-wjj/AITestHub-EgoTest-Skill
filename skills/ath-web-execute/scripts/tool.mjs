#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import {runCli} from './runtime/cli.mjs';
await runCli(process.argv.slice(2),fileURLToPath(new URL('..',import.meta.url)));
