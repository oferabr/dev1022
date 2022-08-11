const { badgen } = require('badgen');
const config = require('../config');

class Badge {
    constructor({ leftText, rightText, rightBackgroundColor }) {
        this.label = leftText;
        this.status = rightText;
        this.color = rightBackgroundColor;

        this.labelColor = config.leftBackgroundColor;
        this.style = 'classic';
        this.icon = config.base64Icon;
        this.iconWidth = 15;
        this.scale = 1;
    }

    getSvgString() {
        const svgString = badgen({
            label: this.label,
            labelColor: this.labelColor,
            status: this.status,
            color: this.color,
            style: this.style,
            icon: this.icon,
            iconWidth: this.iconWidth,
            scale: this.scale
        });
        return svgString;
    }
}

module.exports = Badge;