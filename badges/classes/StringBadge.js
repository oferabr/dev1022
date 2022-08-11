const Badge = require('./Badge');
const config = require('../config');

class StringBadge extends Badge {
    constructor({ title, arg }) {
        if (!title) throw new Error("can't create StringBadge without title!");
        if (typeof arg !== 'string') throw new Error('argument of StringBadge must be a string!');
        super({
            leftText: title,
            rightText: arg,
            rightBackgroundColor: arg === config.allPassing ? config.passColor : config.stringColor
        });
    }
}

module.exports = StringBadge;