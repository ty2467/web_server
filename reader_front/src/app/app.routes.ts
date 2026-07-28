// app.routes.ts
import { Routes, ActivatedRouteSnapshot } from '@angular/router';
import { inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { HomeComponent } from './home/home.component';
import { ArticleDetailComponent } from './articlepage/app-article-detail.component';
import { catchError, map, of } from 'rxjs';

export const routes: Routes = [
  {
    path: 'home',
    component: HomeComponent,
    resolve: {
      articlePool: () =>
        inject(HttpClient).get<{ articlePool: any[] }>('/api/home-page').pipe(
          map(res => res.articlePool),   // <-- unwrap here, so the key IS the array
          catchError(err => {
            console.error('home-page resolve failed', err);
            return of(null);
          })
        )
    }
  },
  {
    path: 'category/:name',
    component: HomeComponent,
    resolve: {
      articlePool: (route: ActivatedRouteSnapshot) =>
        inject(HttpClient).get<{ articlePool: any[] }>(`/api/category/${route.paramMap.get('name')}`).pipe(
          map(res => res.articlePool)
        )
    }
  },
  { path: 'article/:id', component: ArticleDetailComponent },
  { path: '', redirectTo: '/home', pathMatch: 'full' }
];
