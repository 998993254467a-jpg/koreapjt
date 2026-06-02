// React Native에서 react-dom은 필요 없음
// @tanstack/react-query v4가 내부적으로 import하지만 실제로는 사용하지 않음
const unstable_batchedUpdates = (fn) => fn();
module.exports = { unstable_batchedUpdates };
