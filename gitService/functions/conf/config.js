const config = {
    /**
     * list of full repo names that weighing more than 10GB
     */
    blacklist: {
        rgare: ['rgare/uwsolutions-archive'],
        prachakij96: ['prachakij96/AGScorp'],
        aflac: ['aflac/Aflac-SCM'],
        jijakahn6: ['jijakahn6/CharaD7'],
        lendinghome: ['LendingHome/lendinghome-monolith']
    },
    errorCodes: {
        runGitBlame: 'BLAME_CALC_ERROR',
        emptyGitBlame: 'EMPTY_GIT_BLAME',
        unknownLines: 'UNKNOWN_LINES'
    },
    updatedViolationResourcesChunkSize: process.env.UPDATED_VIOLATION_RESOURCES_CHUNK_SIZE || 5000,
    knownGitCloneErrors: {
        branchIsNotAvailable: 'Could not find remote branch'
    }
};

module.exports = config;
