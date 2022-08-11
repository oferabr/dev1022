const bitbucketConfig = {
    auth: {
        baseURL: 'https://bitbucket.org/site/oauth2/access_token'
    },
    apiManager: {
        baseURL: 'https://api.bitbucket.org/2.0',
        MAX_FILES: 5000, // max files per repository
        MAX_PAGE_LENGTH: 100, // 100 is the maximum we can - dont set more then 100, it will throw error
        MAX_RECURSIVE_DEPTH: 100, // the max depth of the files in the repo (recursive)
        PR: {
            newBranchPrefix: 'bc-fix',
            commitDefaultMessage: 'fix: bug',
            defaultAuthor: 'Bridgecrew Bot<no-reply@bridgecrew.io>',
            defaultTitle: '[BC] - terraform security bug',
            defaultDescription: 'Bridgecrew has created this PR to fix vulnerable lines in the terraform file',
            defaultCloseSourceBranch: true
        },
        REPORT: {
            title: 'Bridgecrew Security Scan Report',
            type: 'SECURITY',
            reporter: 'Bridgecrew',
            link: 'https://www.bridgecrew.cloud',
            logoUrl: `https://bridgecrew-app-${process.env.AWS_ACCOUNT_ID}-${process.env.TAG}.s3-${process.env.AWS_REGION}.amazonaws.com/images/bridgeCrew-logo.png`,
            details: 'Bridgecrew performs a static code analysis on infrastructure-as-code. It scans cloud infrastructure managed in Terraform, Cloudformation or Kubernetes and detects misconfigurations.'
        },
        ANNOTATION: {
            type: 'VULNERABILITY'
        }
    },
    bitbucketEnterpriseApiManager: {
        MAX_PAGE_LENGTH: 10000,
        MAX_FILES: 5000, // max files per repository
        PR: {
            newBranchPrefix: 'bc-fix',
            commitDefaultMessage: 'fix: bug',
            defaultTitle: '[BC] - terraform security bug',
            defaultDescription: 'Bridgecrew has created this PR to fix vulnerable lines in the terraform file',
            defaultAuthor: 'Bridgecrew Bot<no-reply@bridgecrew.io>'
        }
    },
    serviceManager: {
        defaultBranch: 'master',
        encoding: 'utf-8', // we get strings as content file from bitbucket server
        webHookRelativePath: 'global/bitbucket/webhook',
        webhookEvents: ['pullrequest:created', 'pullrequest:updated', 'pullrequest:fulfilled', 'pullrequest:rejected'],
        webhookDescription: 'Bridgecrew Webhook',
        reportStatus: {
            passed: 'PASSED',
            failed: 'FAILED',
            pending: 'PENDING'
        },
        downloadIndividualFilesThreshold: 600,
        maxFilesForAPIDownload: 25,
        isLocal: false,
        eventTypes: {
            PR_CREATED: 'pullrequest:created',
            PR_UPDATED: 'pullrequest:updated',
            PR_MERGED: 'pullrequest:fulfilled',
            PR_CLOSED: 'pullrequest:rejected'
        },
        annotationsMaxChunkSize: 99
    },
    bitbucketEnterpriseserviceManager: {
        defaultBranch: 'master',
        encoding: 'utf-8', // we get strings as content file from bitbucket server
        webHookRelativePath: 'global/bitbucketEnterprise/webhook',
        webhookEvents: [
            'pr:merged',
            'pr:reviewer:updated',
            'pr:opened',
            'repo:comment:added',
            'repo:forked',
            'repo:refs_changed',
            'repo:comment:edited',
            'pr:declined',
            'pr:deleted',
            'pr:comment:deleted',
            'repo:comment:deleted',
            'pr:comment:edited',
            'pr:reviewer:unapproved',
            'pr:modified',
            'mirror:repo_synchronized',
            'pr:reviewer:needs_work',
            'pr:reviewer:approved',
            'repo:modified',
            'pr:comment:added'
        ],
        eventTypes: {
            PR_CREATED: 'pr:opened',
            PR_UPDATED: 'repo:refs_changed',
            PR_MERGED: 'pr:merged',
            PR_CLOSED: 'pr:declined'
        },
        webhookName: 'Bridgecrew Webhook',
        reportStatus: {
            passed: 'PASS',
            failed: 'FAIL'
        },
        annotationStatus: {
            passed: 'PASSED',
            failed: 'FAILED'
        },
        annotationsMaxChunkSize: 99,
        downloadIndividualFilesThreshold: 600
    }
};

module.exports = bitbucketConfig;
