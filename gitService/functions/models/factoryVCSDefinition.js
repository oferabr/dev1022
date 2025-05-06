const { SOURCE_TYPES } = require('@bridgecrew/nodeUtils/models/Enums');
const RemoteLambda = require('@bridgecrew/nodeUtils/remoteLambda/invoke');
const BaseVCSDefinition = require('./baseVCSDefinition');
const GithubCloudVCSDefinition = require('./githubCloudVCSDefinition');
const GithubEnterpriseVCSDefinition = require('./githubEnterpriseVCSDefinition');

const githubRemoteLambda = new RemoteLambda(process.env.GITHUB_API_LAMBDA);
const bitbucketRemoteLambda = new RemoteLambda(process.env.BITBUCKET_API_LAMBDA);
const gitlabRemoteLambda = new RemoteLambda(process.env.GITLAB_API_LAMBDA);
const azureReposRemoteLambda = new RemoteLambda(process.env.AZURE_REPOS_API_LAMBDA);

const factoryVCSDefinition = ({ sourceType, customerName, repoOwner }) => {
    switch (sourceType) {
        case SOURCE_TYPES.BITBUCKET:
            return new BaseVCSDefinition({ remoteLambda: bitbucketRemoteLambda, functionName: 'makePullRequest' });
        case SOURCE_TYPES.BITBUCKET_ENTERPRISE:
            return new BaseVCSDefinition({ remoteLambda: bitbucketRemoteLambda, functionName: 'enterprise/makePullRequest' });
        case SOURCE_TYPES.GITLAB:
            return new BaseVCSDefinition({ remoteLambda: gitlabRemoteLambda, functionName: 'makePullRequest' });
        case SOURCE_TYPES.GITLAB_ENTERPRISE:
            return new BaseVCSDefinition({ remoteLambda: gitlabRemoteLambda, functionName: 'enterprise/makePullRequest' });
        case SOURCE_TYPES.AZURE_REPOS:
            return new BaseVCSDefinition({ remoteLambda: azureReposRemoteLambda, functionName: 'service/makePullRequest' });
        case SOURCE_TYPES.GITHUB:
            return new GithubCloudVCSDefinition({ remoteLambda: githubRemoteLambda, functionName: 'makePullRequest', customerName, repoOwner });
        case SOURCE_TYPES.GITHUB_ENTERPRISE:
            return new GithubEnterpriseVCSDefinition({ remoteLambda: githubRemoteLambda, functionName: 'enterprise/makePullRequest' });
        default:
            throw new Error(`FactoryVCSDefinition Error: no implementation for source type: ${sourceType}`);
    }
};

module.exports = factoryVCSDefinition;