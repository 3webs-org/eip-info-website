import config from "../../js/config.js";

import yaml from "js-yaml";

export default {
    paths() {
        let paths = [];

        for (let eip in config.eips) {
            paths.push({
                params: {
                    eip: eip.data.eip
                },
                content: `---\n${yaml.dump(eip.data)}\n---\n\n${eip.content}` // Hacky way to recreate the original file
            })
        }

        return paths;
    }
}