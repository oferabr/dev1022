const BooleanBadge = require('./classes/BooleanBadge');
const StringBadge = require('./classes/StringBadge');
const NotAvailableBadge = require('./classes/NotAvailableBadge');

const BADGE_TYPES = {
    BOOLEAN: 'BOOLEAN',
    STRING: 'STRING',
    NOT_AVAILABLE: 'NOT_AVAILABLE'
};

const BADGE_ID_MAP = {
    general: {
        order: 1,
        title: 'Infrastructure Security',
        type: BADGE_TYPES.STRING,
        BadgeClass: StringBadge
    },
    cis_aws: {
        order: 2,
        title: 'CIS AWS V1.2',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    cis_azure: {
        order: 3,
        title: 'CIS AZURE V1.1',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    pci: {
        order: 4,
        title: 'PCI-DSS V3.2',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    nist: {
        order: 5,
        title: 'NIST-800-53',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    iso: {
        order: 6,
        title: 'ISO27001',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    soc2: {
        order: 7,
        title: 'SOC2',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    cis_gcp: {
        order: 8,
        title: 'CIS GCP V1.1',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    hipaa: {
        order: 9,
        title: 'HIPAA',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    pci_dss_v321: {
        order: 10,
        title: 'PCI-DSS V3.2.1',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    fedramp_moderate: {
        order: 11,
        title: 'FEDRAMP (MODERATE)',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    cis_kubernetes: {
        order: 12,
        title: 'CIS KUBERNETES V1.5',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    cis_aws_13: {
        order: 13,
        title: 'CIS AWS V1.3',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    cis_azure_13: {
        order: 14,
        title: 'CIS AZURE V1.3',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    cis_docker_12: {
        order: 15,
        title: 'CIS DOCKER V1.2',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    cis_eks_11: {
        order: 16,
        title: 'CIS EKS V1.1',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    cis_gke_11: {
        order: 17,
        title: 'CIS GKE V1.1',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    cis_kubernetes_16: {
        order: 18,
        title: 'CIS KUBERNETES V1.6',
        type: BADGE_TYPES.BOOLEAN,
        BadgeClass: BooleanBadge
    },
    not_available: {
        title: 'Infrastructure Tests',
        type: BADGE_TYPES.NOT_AVAILABLE,
        BadgeClass: NotAvailableBadge
    }
};

const MAP_BADGE_TITLE_TO_ID = Object.keys(BADGE_ID_MAP).reduce((map, badgeID) => {
    // eslint-disable-next-line no-param-reassign
    map[BADGE_ID_MAP[badgeID].title] = badgeID;
    return map;
}, {});

class FactoryBadge {
    /**
     * @param id - STRING
     * @param argument - BOOLEAN/STRING
     * @returns Badge instance
     * Examples:
     * Boolean type: FactoryBadge.createBadge('pci', true);
     * String type: FactoryBadge.createBadge('general', '37 errors');
     * Not available type: FactoryBadge.createBadge('notAvailable', 'Infrastructure Tests');
     */
    static createBadge(id, argument) {
        const badge = BADGE_ID_MAP[id];

        if (!badge) throw new Error(`No badge id for: ${id}`);

        if (!badge.title) throw new Error('can\'t create badge without title, check the BADGE_ID_MAP');
        if (!badge.BadgeClass) throw new Error('can\'t create badge without BadgeClass, check the BADGE_ID_MAP');

        return new badge.BadgeClass({ title: badge.title, arg: argument });
    }
}

module.exports = { FactoryBadge, MAP_BADGE_TITLE_TO_ID, BADGE_ID_MAP };
