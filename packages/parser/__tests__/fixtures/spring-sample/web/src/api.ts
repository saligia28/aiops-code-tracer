// 前端调用后端 GET /users/{id}，端点与 Spring UserController 对齐。
// 用 ambient 声明而非真实 axios 依赖：TS extractor 按 `axios.get` 标识符识别 apiCall。
declare const axios: { get(url: string): Promise<unknown> };

export function fetchUser() {
  return axios.get('/users/{id}');
}
