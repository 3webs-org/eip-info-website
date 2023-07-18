import config from "../../js/config.js";

import yaml from "js-yaml";

export default {
    paths() {
        let paths = [];

        for (let eip in config.eips) {
            let eipData = config.eips[eip];
            paths.push({
                params: {
                    eip: eip
                },
                content: `---\n${yaml.dump(eipData.data)}\n---\n\n${eipData.content}` // Hacky way to recreate the original file
            })
        }

        return paths;
    }
}
