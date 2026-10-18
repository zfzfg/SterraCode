export const route = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
