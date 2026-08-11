import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import './styles.css';

const routes = [
  { path: '/', redirect: '/overview' },
  { path: '/overview', component: App },
  { path: '/users', component: App },
  { path: '/usage', component: App },
  { path: '/accounts', component: App },
  { path: '/suppliers', component: App },
  { path: '/supplier-keys', component: App },
  { path: '/supplier-quality', component: App },
  { path: '/oauth-supply', component: App },
  { path: '/replenishment', component: App },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

createApp(App).use(createPinia()).use(router).mount('#app');
