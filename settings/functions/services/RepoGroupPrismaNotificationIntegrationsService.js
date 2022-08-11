const { getInstance, RepositoriesGroupPrismaNotificationIntegration } = require('@bridgecrew/dal-layer');

class RepoGroupPrismaNotificationIntegrationsService {
    static connection;

    static async getConnection() {
        if (!RepoGroupPrismaNotificationIntegrationsService.connection) {
            RepoGroupPrismaNotificationIntegrationsService.connection = await getInstance().connect();
        }
        return RepoGroupPrismaNotificationIntegrationsService.connection;
    }

    async getRepoGroupsPcNotificationIntegrations(prismaNotificationIntegrationIds) {
        const pcRepoGroupsNotificationIntegrationsRepository = (await RepoGroupPrismaNotificationIntegrationsService.getConnection()).getRepository(RepositoriesGroupPrismaNotificationIntegration);
        return await pcRepoGroupsNotificationIntegrationsRepository.findByIds(prismaNotificationIntegrationIds);
    }

    async deleteRepoGroupsPcNotificationIntegrations(prismaNotificationIntegrationIds) {
        const pcRepoGroupsNotificationIntegrationsRepository = (await RepoGroupPrismaNotificationIntegrationsService.getConnection()).getRepository(RepositoriesGroupPrismaNotificationIntegration);
        return await pcRepoGroupsNotificationIntegrationsRepository.delete(prismaNotificationIntegrationIds);
    }
}

module.exports = RepoGroupPrismaNotificationIntegrationsService;