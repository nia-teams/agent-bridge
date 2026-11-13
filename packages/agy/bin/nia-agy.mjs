#!/usr/bin/env node
import { main } from '../dist/cli.js';
main().catch(error => { console.error(`nia-agy: ${error.message}`); process.exitCode = 1; });
