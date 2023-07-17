import eipInfo from './eipInfo.js';

export default {
    "statuses": [
        "Living", "Last Call", "Final", "Review", "Draft", "Stagnant", "Withdrawn"
    ],
    "types": [
        "Standards Track",
        "Informational",
        "Meta"
    ],
    "categories": {
        "Standards Track": [
            "Core",
            "ERC",
            "Interface",
            "Networking",
        ],
    },
    "eips": eipInfo,
};
