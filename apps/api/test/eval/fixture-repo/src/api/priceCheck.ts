// 核价管理相关接口
import axios from 'axios'

/** 核价列表 */
export function getPriceCheckList(query: Record<string, unknown>) {
  return axios.get('/api/price/check/list', { params: query })
}
