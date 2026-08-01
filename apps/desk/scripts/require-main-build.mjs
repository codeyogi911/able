const branch = process.env.WORKERS_CI_BRANCH?.trim()

if (process.env.WORKERS_CI && branch !== 'main') {
  throw new Error(`Production deployment is restricted to the main branch; received ${branch || 'an unknown branch'}`)
}
