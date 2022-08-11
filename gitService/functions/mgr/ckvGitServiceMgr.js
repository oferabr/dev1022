const fs = require('fs');
const RemoteLambda = require('@bridgecrew/nodeUtils/remoteLambda/invoke');
const { execSync } = require('child_process');
const yamlParser = require('js-yaml');
const YAML = require('json2yaml');
const { getAllResourceTypes } = require('@bridgecrew/definition-language');

const violationsApiRemoteLambda = new RemoteLambda(process.env.VIOLATIONS_API_LAMBDA_NAME);
const policiesApiRemoteLambda = new RemoteLambda(process.env.POLICIES_API_LAMBDA_NAME);

class CkvGitServiceMgr {
    async getPolicies() {
        const policies = await policiesApiRemoteLambda.invoke('policies/getPolicies', { customerName: null });
        const filteredPolicies = policies.filter(p => p.checkovCheckId);
        const checkovPolicies = {};
        filteredPolicies.forEach(p => {
            checkovPolicies[p.checkovCheckId] = { incidentId: p.incidentId, severity: p.severity, guideline: p.guideline, title: p.constructiveTitle || p.descriptiveTitle || p.title };
        });
        return checkovPolicies;
    }

    preparePolicy({ content, confIncident, runtime }) {
        const parsedContent = { ...content };
        parsedContent.metadata.guidelines = confIncident.guideline;
        parsedContent.metadata.severity = confIncident.severity.toLowerCase();
        parsedContent.metadata.category = content.metadata.category.toLowerCase();
        parsedContent.metadata.name = confIncident.title;
        parsedContent.scope = { provider: runtime };
        const { incidentId } = confIncident;

        const { newQuery } = getAllResourceTypes(({ query: parsedContent.definition, resourceTypes: new Set() }));

        const parserContent = { metadata: parsedContent.metadata, scope: parsedContent.scope, definition: parsedContent.definition };
        const ymlText = YAML.stringify(parserContent);
        return { incidentId, code: ymlText, conditionQuery: newQuery };
    }

    async saveCkvFilesCode() {
        const checkovUrl = 'https://github.com/bridgecrewio/checkov.git';
        const clonePath = '/tmp/checkov';
        const graphChecksPath = `${clonePath}/checkov/terraform/checks/graph_checks`;

        try {
            if (fs.existsSync(clonePath)) execSync(`rm -rf ${clonePath}`, { encoding: 'utf8', stdio: 'inherit' });
            execSync(`git clone --depth 1 ${checkovUrl} ${clonePath}`, { encoding: 'utf8', stdio: 'inherit' });
            console.log('[saveCkvFilesCode] cloned checkov');
            const checkovPolicies = await this.getPolicies();
            const runtimeValues = ['aws', 'gcp', 'azure'];
            await Promise.all(runtimeValues.map(async runtime => {
                const dirname = `${graphChecksPath}/${runtime}`;
                const incidents = [];
                fs.readdirSync(dirname).map(async file => {
                    const content = yamlParser.safeLoad(fs.readFileSync(`${dirname}/${file}`, 'utf8'));
                    const { id } = content.metadata;
                    delete content.metadata.id;
                    const confIncident = checkovPolicies[id];
                    if (confIncident) {
                        incidents.push(this.preparePolicy({ content, confIncident, runtime }));
                    }
                });

                console.log('[saveCkvFilesCode] saving checkov code for ', runtime);
                await violationsApiRemoteLambda.invoke('staticData/updateCheckovCode', { data: incidents }, undefined, { newInvoke: true, useLatest: true });
            }));
        } catch (err) {
            console.log('error', err);
            throw new Error('failed to update static data in db');
        } finally {
            console.log('[saveCkvFilesCode] deleting checkov');
            execSync(`rm -rf ${clonePath}`, { encoding: 'utf8', stdio: 'inherit' });
        }
    }
}

module.exports = { CkvGitServiceMgr };