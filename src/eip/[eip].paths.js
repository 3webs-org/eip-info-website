import eips from "../../.vitepress/eipInfo.js";

import yaml from "js-yaml";

export default {
    paths() {
        let paths = [];

        for (let eip in eips) {
            let eipData = eips[eip];
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
