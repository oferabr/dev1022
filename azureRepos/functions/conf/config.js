const azureReposConfig = {
    auth: {
        baseURL: 'https://app.vssps.visualstudio.com/oauth2/token'
    },
    apiManager: {
        baseURL: 'https://dev.azure.com',
        API_VERSION: '6.0',
        VSTS_URL: 'https://app.vssps.visualstudio.com',
        PR: {
            newBranchPrefix: 'bc-fix',
            commitDefaultMessage: 'fix: bug',
            defaultAuthor: 'Bridgecrew Bot<no-reply@bridgecrew.io>',
            defaultTitle: '[BC] - terraform security bug',
            defaultDescription: 'Bridgecrew has created this PR to fix vulnerable lines in the terraform file',
            defaultCloseSourceBranch: true
        }
    },
    serviceManager: {
        downloadIndividualFilesThreshold: 1000,
        maxConcurrentDownloadFiles: 50,
        encoding: 'utf-8',
        webHookRelativePath: 'global/azureRepos/webhook',
        minFilesForGitClone: 100, // If the total amount of files (of all the repos) is greater, use git clone
        gitCloneEncoding: 'utf-8'
    },
    DEFAULT_BRANCH: 'main',
    BLOB_TYPE: 'blob',
    SRC: 'src',
    ENCODING: 'utf-8',
    webhook: {
        eventTypes: {
            PR_CREATED: 'git.pullrequest.created',
            PR_UPDATED: 'git.pullrequest.updated',
            PR_MERGED: 'git.pullrequest.merged'
        }
    }
};

module.exports = azureReposConfig;
