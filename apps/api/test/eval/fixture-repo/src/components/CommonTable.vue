<template>
  <div class="common-table">
    <!-- 公共表格组件：内置分页（每页 pageSize 条） -->
    <slot />
    <div class="pagination">
      <span>每页 {{ pageSize }} 条，第 {{ pageNum }} 页</span>
    </div>
  </div>
</template>

<script>
export default {
  name: 'CommonTable',
  props: {
    fetchTableData: { type: Function, required: true },
  },
  data() {
    return {
      // 分页默认值：每页 20 条
      pageNum: 1,
      pageSize: 20,
    }
  },
  methods: {
    handlePageChange(pageNum) {
      this.pageNum = pageNum
      return this.fetchTableData({ pageNum: this.pageNum, pageSize: this.pageSize })
    },
  },
}
</script>
