const Badge = require('./Badge');
const config = require('../config');

class BooleanBadge extends Badge {
    constructor({ title, arg }) {
        if (!title) throw new Error("can't create BooleanBadge without title!");
        if (typeof arg !== 'boolean') throw new Error('argument of BooleanBadge must be a boolean!');
        super({
            leftText: title,
            rightText: arg ? 'Compliant' : 'Non compliant',
            rightBackgroundColor: arg ? config.passColor : config.failColor
        });
    }
}

module.exports = BooleanBadge;