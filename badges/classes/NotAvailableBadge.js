const Badge = require('./Badge');
const config = require('../config');

class NotAvailableBadge extends Badge {
    constructor({ title }) {
        if (!title) throw new Error("can't create NotAvailableBadge without title!");
        super({
            leftText: title,
            rightText: 'N/A',
            rightBackgroundColor: config.notAvailableColor
        });
    }
}

module.exports = NotAvailableBadge;