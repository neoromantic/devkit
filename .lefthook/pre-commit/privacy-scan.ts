// Lefthook runs this from its checkout of the devkit remote: scan the staged changes.
import { main } from '../../scripts/privacy-scan.ts'

process.exit(await main(['--staged']))
