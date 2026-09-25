import { Component } from '@angular/core';

@Component({
  selector: 'app-contact',
  standalone: true,
  templateUrl: './contact.component.html',
  styleUrls: ['./contact.component.css'],
})
export class ContactComponent {
  socials = [
    { name: 'Weibo',     url: 'https://www.weibo.com/ifengus?is_hot=1' },
    { name: 'Facebook',  url: 'https://www.facebook.com/PhoenixTV' },
    { name: 'Instagram', url: 'https://www.instagram.com/phoenixtvus/?hl=zh-cn' },
    { name: 'Twitter',   url: 'https://twitter.com/PhoenixTVUSA' },
    { name: 'YouTube',   url: 'https://www.youtube.com/channel/UCnTj6j09xZ4SUD5ym_fW52w?view_as=public' },
  ];
}
