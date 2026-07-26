import { bootstrapDatabase } from './bootstrap'
import { migrate } from './migrate'
import { seed } from './seed'

async function main(): Promise<void> {
  const cmd = process.argv[2]
  switch (cmd) {
    case 'bootstrap':
      await bootstrapDatabase()
      break
    case 'migrate':
      await migrate()
      break
    case 'seed':
      await seed()
      break
    case 'setup':
      await bootstrapDatabase()
      await seed()
      console.log('DB setup finished')
      break
    default:
      console.error('Usage: vite-node server/db/cli.ts <setup|bootstrap|migrate|seed>')
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
