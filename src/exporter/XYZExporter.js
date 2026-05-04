export class XYZExporter {
    //@fertegi - this export does not work with multiple point clouds yet

    /**
     * Converts the given points to an XYZ string.
     * @param {Points} points The points to convert.
     * @returns {string} The XYZ string.
     */
    static toString(points) {
        let string = '';
        let attributes = Object.keys(points.data)
            .filter(a => a !== 'normal')
            .sort((a, b) => {
                if (a === 'position') return -1;
                if (b === 'position') return 1;
                if (a === 'rgba') return -1;
                if (b === 'rgba') return 1;
            });

        for (let i = 0; i < points.numPoints; i++) {
            let values = [];

            for (let attribute of attributes) {
                let itemSize = points.data[attribute].length / points.numPoints;
                let value = points.data[attribute]
                    .subarray(itemSize * i, itemSize * i + itemSize)
                    .join('	');
                values.push(value);
            }

            string += values.join(' ') + '\n';
        }

        return string;
    }
}