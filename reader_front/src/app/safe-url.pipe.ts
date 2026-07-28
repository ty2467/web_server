import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

@Pipe({
  name: 'safeUrl',
  standalone: true
})
export class SafeUrlPipe implements PipeTransform {
  private sanitizer = inject(DomSanitizer);

  transform(url: string | undefined): SafeResourceUrl | string {
    if (!url) return '';
    // Append the frame fragment if not present
    const frameUrl = url.includes('#') ? url : `${url}#t=0.1`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(frameUrl);
  }
}
