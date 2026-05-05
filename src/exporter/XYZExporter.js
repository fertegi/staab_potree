export class XYZExporter {

    /**
     * Converts the given points to an XYZ string.
     * @param {Points} points The points to convert.
     * @param {{x: number, y: number, z: number}|null} offset Optional offset applied to position values.
     * @returns {string} The XYZ string.
     */
    static toString(points, offset = null) {
        let string = '';
        let attributes = Object.keys(points.data)
            .filter(a => a !== 'normal')
            .sort((a, b) => {
                if (a === 'position') return -1;
                if (b === 'position') return 1;
                if (a === 'rgba') return -1;
                if (b === 'rgba') return 1;
            });

        let ox = offset ? offset.x : 0;
        let oy = offset ? offset.y : 0;
        let oz = offset ? offset.z : 0;
        let applyOffset = ox !== 0 || oy !== 0 || oz !== 0;

        for (let i = 0; i < points.numPoints; i++) {
            let values = [];

            for (let attribute of attributes) {
                let itemSize = points.data[attribute].length / points.numPoints;
                if (attribute === 'position' && applyOffset) {
                    let base = itemSize * i;
                    let arr = points.data[attribute];
                    values.push(`${arr[base] + ox}	${arr[base + 1] + oy}	${arr[base + 2] + oz}`);
                } else {
                    let value = points.data[attribute]
                        .subarray(itemSize * i, itemSize * i + itemSize)
                        .join('	');
                    values.push(value);
                }
            }

            string += values.join(' ') + '\n';
        }

        return string;
    }
}