// Worker URL once it's deployed (see worker/README.md). While it's empty the maps read SEPTA
// directly and the spot cards go without Google reviews.
const PRODUCTION_API = '';

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

export const API_BASE = LOCAL ? 'http://127.0.0.1:8787' : PRODUCTION_API;
