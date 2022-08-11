const BaseVCSDefinition = require('./baseVCSDefinition');

class GithubCloudVCSDefinition extends BaseVCSDefinition {
    constructor({ customerName, repoOwner, remoteLambda, functionName }) {
        super({ remoteLambda, functionName });
        this.customerName = customerName;
        this.repoOwner = repoOwner;
    }

    getEncoding() {
        return 'utf8';
    }

    async addAdditionalPRParams() {
        console.info(`getting installationId for customer: ${this.customerName} for repo owner: ${this.repoOwner}`);
        try {
            const repositoriesDetails = await this._remoteLambda.invoke('getRepositories', { customerName: this.customerName });
            const repositoriesDetailsData = repositoriesDetails.data;
            const repoData = repositoriesDetailsData.find(details => details.orgName === this.repoOwner);
            const { installationId } = repoData;
            if (!installationId) {
                throw new Error(`can't get installationId for customer: ${this.customerName} with repo owner: ${this.repoOwner}`);
            }
            return { installationId };
        } catch (e) {
            console.error(`got error while trying to fetch installationId for ${this.customerName} with repo owner: ${this.repoOwner}`);
            throw e;
        }
    }
}

module.exports = GithubCloudVCSDefinition;