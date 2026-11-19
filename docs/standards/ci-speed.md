# CI speed standard

How CI stays fast in repos that use devkit. The measure is the time from opening a pull request
to merging it: agents write most of the code, so the wait is CI.

## What a pull request runs

- A pull request gets the answer needed to merge that change. Broader proof, such as other
  runtime versions, other platforms or the latest dependencies, runs after merge on `main`, on a
  schedule, on request (`workflow_dispatch`), or on a pull request whose diff touches the files
  it protects.
- One runtime version per language on pull requests: the one in `.python-version`,
  `.bun-version` or `packageManager`, or `go.mod`. A version or platform matrix on pull requests
  needs a recorded failure that only it caught; link that run in a comment beside the matrix.

```yaml
build:
  uses: neoromantic/devkit/.github/workflows/ci-python.yml@v1
  with:
    python-version: ${{ github.event_name == 'pull_request' && '[""]' || '["3.11","3.14"]' }}
```

## Skip what the diff cannot affect

- A job the diff cannot affect does not start. Decide in the job's `if` or in a first cheap
  step, before checkout and setup, from the pull request's changed files.
- The pattern names everything the job reads, its workflow file included. Lockfiles, root
  configs, shared packages and anything unclear mean run. Pushes to `main`, schedules and manual
  runs never skip.
- Never put `paths:` on the workflow that holds the required `ci` check: a pull request it
  filters out never gets `ci` and can't merge. The `ci` gate in the devkit stubs passes a
  skipped job and fails a failed or cancelled one.

```yaml
plugin:
  runs-on: ubuntu-latest
  permissions: { contents: read, pull-requests: read }
  steps:
    - name: Files this job reads
      id: changes
      if: github.event_name == 'pull_request'
      env:
        GH_TOKEN: ${{ github.token }}
        PR: ${{ github.event.pull_request.number }}
      run: |
        files="$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR/files" --paginate --jq '.[].filename')"
        grep -qE '^(plugin/|bun\.lock$|\.github/workflows/ci\.yml$)' <<< "$files" ||
          echo "skip=true" >> "$GITHUB_OUTPUT"
    - if: steps.changes.outputs.skip != 'true'
      uses: actions/checkout@<sha> # vX.Y.Z
    # …every later step has the same `if`
```

## Caches

- A cache goes in when it is simple, a step or an input with no setup in each repo, and the next
  run of a job someone waits for shows a net saving: restoring it costs less than the work it
  saves. There is no fixed threshold, and a job that already meets its time target still takes a
  simple measured win.
- A cache that fails the measurement stays out, and the pull request that measured it records
  the numbers. A configured cache that rarely hits, or costs more to save and restore than it
  saves, is removed the same way.
- On GitHub-hosted runners, restoring an Actions cache costs 0.3 s or more and saving one 1–3 s.
  That pays for saved work such as compiling, not for downloads of a second or less: the Bun
  binary, uv packages, tool binaries. A pull request reads only the caches its own branch or the
  base branch saved, so a cache that only a self-hosted `main` would write never reaches it.
- A cache is verified, not configured: the next run's log shows the hit, such as
  `Cache restored from key` or `Found in cache`, and the step got faster. Report both runs.
- One key per job, built from everything that changes the contents: the lockfile hash, the
  runtime version and the OS. Never a cache that one job writes and another reads with different
  contents.
- Go: for one job, setup-go's own cache is enough (`cache-dependency-path` at `go.sum`, or at
  `go.mod` without dependencies). Several Go jobs set `cache: false` and use an `actions/cache`
  restore and save per job, keyed `go-<job>-<os>-<go version>-<go.sum hash>-<sha>` and restored
  by the key without the sha. It saves on pushes and on a pull request run that restored
  nothing. `go test` reuses a result only when the files it read keep their mtime, so a step
  after checkout sets each file's mtime to its last commit time. Build cache entries hold
  absolute paths, so a self-hosted runner's cache can't seed GitHub-hosted runs.
- In a workspace, the task runner caches test results by the package's inputs and those of its
  dependencies, so a change to a dependency still reruns the tests. A package whose tests read
  files outside it turns the cache off for its own tests.
- A slow step is not always a miss. A step that installs and then runs `check` is as slow as its
  type check; a self-hosted runner downloads a toolchain once and finds it in its tool cache on
  later runs.

## Tests

- Tests run in parallel workers in one job; see
  [the testing standard](testing.md#parallel-by-default). At the size of the repos on devkit,
  that is enough: no sharding across jobs and no test selection.
- The test step is usually the longest. Make the suite smaller with a
  [cleanup campaign](testing.md#cleanup-campaign) before adding jobs.

## Measure

- Numbers come from real runs. `gh run view <id> --json jobs` gives every job's and step's start
  and end. Compare the same job on the same kind of runner, and keep queue time apart from run
  time.
- Report before and after with run links. Anything not measured is labelled an assumption.
