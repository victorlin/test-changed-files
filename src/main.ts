import * as core from '@actions/core'
import * as github from '@actions/github'
import path from 'path'
import {
  processChangedFiles,
  ChangeTypeEnum,
  getAllDiffFiles,
  getChangedFilesFromGithubAPI,
  getRenamedFiles
} from './changedFiles'
import {
  DiffResult,
  getSHAForNonPullRequestEvent,
  getSHAForPullRequestEvent
} from './commitSha'
import {Env, getEnv} from './env'
import {getInputs, Inputs} from './inputs'
import {
  getFilePatterns,
  getRecoverFilePatterns,
  getSubmodulePath,
  getYamlFilePatterns,
  hasLocalGitDirectory,
  isRepoShallow,
  recoverDeletedFiles,
  setOutput,
  submoduleExists,
  updateGitGlobalConfig,
  verifyMinimumGitVersion,
  warnUnsupportedRESTAPIInputs
} from './utils'

const getChangedFilesFromLocalGitHistory = async ({
  inputs,
  env,
  workingDirectory,
  filePatterns,
  yamlFilePatterns
}: {
  inputs: Inputs
  env: Env
  workingDirectory: string
  filePatterns: string[]
  yamlFilePatterns: Record<string, string[]>
}): Promise<void> => {
  await verifyMinimumGitVersion()

  let quotepathValue = 'on'

  if (!inputs.quotepath) {
    quotepathValue = 'off'
  }

  await updateGitGlobalConfig({
    name: 'core.quotepath',
    value: quotepathValue
  })

  if (inputs.diffRelative) {
    await updateGitGlobalConfig({
      name: 'diff.relative',
      value: 'true'
    })
  }

  const isShallow = await isRepoShallow({cwd: workingDirectory})
  const hasSubmodule = await submoduleExists({cwd: workingDirectory})
  let gitFetchExtraArgs = ['--no-tags', '--prune', '--recurse-submodules']
  const isTag = env.GITHUB_REF?.startsWith('refs/tags/')
  const outputRenamedFilesAsDeletedAndAdded =
    inputs.outputRenamedFilesAsDeletedAndAdded
  let submodulePaths: string[] = []

  if (hasSubmodule) {
    submodulePaths = await getSubmodulePath({cwd: workingDirectory})
  }

  if (isTag) {
    gitFetchExtraArgs = ['--prune', '--no-recurse-submodules']
  }

  let diffResult: DiffResult

  if (!github.context.payload.pull_request?.base?.ref) {
    core.info(`Running on a ${github.context.eventName || 'push'} event...`)
    diffResult = await getSHAForNonPullRequestEvent(
      inputs,
      env,
      workingDirectory,
      isShallow,
      hasSubmodule,
      gitFetchExtraArgs,
      isTag
    )
  } else {
    core.info(
      `Running on a ${github.context.eventName || 'pull_request'} (${
        github.context.payload.action
      }) event...`
    )
    diffResult = await getSHAForPullRequestEvent(
      inputs,
      env,
      workingDirectory,
      isShallow,
      hasSubmodule,
      gitFetchExtraArgs
    )
  }

  if (diffResult.initialCommit) {
    core.info('This is the first commit for this repository; exiting...')
    core.endGroup()
    return
  }

  core.info(
    `Retrieving changes between ${diffResult.previousSha} (${diffResult.targetBranch}) → ${diffResult.currentSha} (${diffResult.currentBranch})`
  )

  const allDiffFiles = await getAllDiffFiles({
    workingDirectory,
    hasSubmodule,
    diffResult,
    submodulePaths,
    outputRenamedFilesAsDeletedAndAdded,
    fetchAdditionalSubmoduleHistory: inputs.fetchAdditionalSubmoduleHistory,
    failOnInitialDiffError: inputs.failOnInitialDiffError,
    failOnSubmoduleDiffError: inputs.failOnSubmoduleDiffError
  })
  core.debug(`All diff files: ${JSON.stringify(allDiffFiles)}`)
  core.info('All Done!')
  core.endGroup()

  if (inputs.recoverDeletedFiles) {
    let recoverPatterns = getRecoverFilePatterns({inputs})

    if (recoverPatterns.length > 0 && filePatterns.length > 0) {
      core.info('No recover patterns found; defaulting to file patterns')
      recoverPatterns = filePatterns
    }

    await recoverDeletedFiles({
      inputs,
      workingDirectory,
      deletedFiles: allDiffFiles[ChangeTypeEnum.Deleted],
      recoverPatterns,
      diffResult,
      hasSubmodule,
      submodulePaths
    })
  }

  await processChangedFiles({
    filePatterns,
    allDiffFiles,
    inputs,
    yamlFilePatterns,
    workingDirectory
  })

  if (inputs.includeAllOldNewRenamedFiles) {
    core.startGroup('changed-files-all-old-new-renamed-files')
    const allOldNewRenamedFiles = await getRenamedFiles({
      inputs,
      workingDirectory,
      hasSubmodule,
      diffResult,
      submodulePaths
    })
    core.debug(`All old new renamed files: ${allOldNewRenamedFiles}`)
    await setOutput({
      key: 'all_old_new_renamed_files',
      value: allOldNewRenamedFiles.paths,
      writeOutputFiles: inputs.writeOutputFiles,
      outputDir: inputs.outputDir,
      json: inputs.json,
      safeOutput: inputs.safeOutput
    })
    await setOutput({
      key: 'all_old_new_renamed_files_count',
      value: allOldNewRenamedFiles.count,
      writeOutputFiles: inputs.writeOutputFiles,
      outputDir: inputs.outputDir,
      json: inputs.json
    })
    core.info('All Done!')
    core.endGroup()
  }
}

const getChangedFilesFromRESTAPI = async ({
  inputs,
  filePatterns,
  yamlFilePatterns
}: {
  inputs: Inputs
  filePatterns: string[]
  yamlFilePatterns: Record<string, string[]>
}): Promise<void> => {
  const allDiffFiles = await getChangedFilesFromGithubAPI({
    inputs
  })
  core.debug(`All diff files: ${JSON.stringify(allDiffFiles)}`)
  core.info('All Done!')

  await processChangedFiles({
    filePatterns,
    allDiffFiles,
    inputs,
    yamlFilePatterns
  })
}

export async function run(): Promise<void> {
  core.startGroup('changed-files')

  const env = await getEnv()
  core.debug(`Env: ${JSON.stringify(env, null, 2)}`)

  const inputs = getInputs()
  core.debug(`Inputs: ${JSON.stringify(inputs, null, 2)}`)

  core.debug(`Github Context: ${JSON.stringify(github.context, null, 2)}`)

  const workingDirectory = path.resolve(
    env.GITHUB_WORKSPACE || process.cwd(),
    inputs.useRestApi ? '.' : inputs.path
  )
  core.debug(`Working directory: ${workingDirectory}`)

  const hasGitDirectory = await hasLocalGitDirectory({workingDirectory})
  core.debug(`Has git directory: ${hasGitDirectory}`)

  const filePatterns = await getFilePatterns({
    inputs,
    workingDirectory
  })
  core.debug(`File patterns: ${filePatterns}`)

  const yamlFilePatterns = await getYamlFilePatterns({
    inputs,
    workingDirectory
  })
  core.debug(`Yaml file patterns: ${JSON.stringify(yamlFilePatterns)}`)

  if (inputs.useRestApi && !github.context.payload.pull_request?.number) {
    throw new Error(
      "Only pull_request* events are supported when using GitHub's REST API."
    )
  }

  if (
    inputs.token &&
    github.context.payload.pull_request?.number &&
    (!hasGitDirectory || inputs.useRestApi)
  ) {
    core.info("Using GitHub's REST API to get changed files")
    if (process.env.GITHUB_ACTION_PATH) {
      await warnUnsupportedRESTAPIInputs({
        actionPath: path.join(process.env.GITHUB_ACTION_PATH, 'action.yml'),
        inputs
      })
    }
    await getChangedFilesFromRESTAPI({
      inputs,
      filePatterns,
      yamlFilePatterns
    })
  } else {
    if (!hasGitDirectory) {
      core.info(`Running on a ${github.context.eventName} event...`)
      throw new Error(
        `Can't find local .git in ${workingDirectory} directory. Please run actions/checkout before this action (Make sure the 'path' input is correct). If you intend to use Github's REST API note that only pull_request* events are supported.`
      )
    }

    core.info('Using local .git directory')
    await getChangedFilesFromLocalGitHistory({
      inputs,
      env,
      workingDirectory,
      filePatterns,
      yamlFilePatterns
    })
  }
}

/* istanbul ignore if */
if (!process.env.TESTING) {
  // eslint-disable-next-line github/no-then
  run().catch(e => {
    core.setFailed(e.message || e)
    process.exit(1)
  })
}
