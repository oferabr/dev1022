const { UnauthorizedError, InternalServerError, NotImplementedError } = require('@bridgecrew/api');
const { BadgesService } = require('./service');

const badgesService = new BadgesService();

const getBadges = async (req, res, next) => {
    const { customerName, accounts } = req.userDetails;
    const { vcs, repoOwner, repoName } = req.params;
    const { branchName } = req.query;
    console.info(`getting badges for customer: ${customerName} vcs: ${vcs} repoOwner:${repoOwner} repoName: ${repoName}`);
    if (branchName) {
        console.warn(`trying to get badges with branch name: ${branchName} - we currently not support badge per branch`);
        return next(new NotImplementedError('Not support branchName yet'));
    }

    if (vcs !== 'github') {
        console.warn(`trying to get badges of vcs: ${vcs} - we currently not support this vcs`);
        return next(new NotImplementedError('Vcs not supported'));
    }

    try {
        if (!accounts.includes(`${repoOwner}/${repoName}`)) {
            console.warn('trying to get badges for repository without permission', { accounts, fullRepoName: `${repoOwner}/${repoName}` });
            return next(new UnauthorizedError('bad repository name'));
        }

        const badges = await badgesService.get({ customerName, vcs, repoOwner, repoName, branchName });

        return res.status(200).json(badges);
    } catch (err) {
        console.error(`failed to get badges for customer ${customerName} and repository ${repoName}. Error: `, err);
        next(new InternalServerError(`failed to get badges for customer ${customerName} and repository ${repoName}`));
    }
};

module.exports = {
    getBadges
};
